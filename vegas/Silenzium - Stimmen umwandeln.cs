/**
 * Silenzium – Stimmen umwandeln (VEGAS Pro 14 und neuer)
 *
 * Für jede gewählte Original-Spur („Anna“):
 *   1. Spur solo schalten und die Zeitauswahl (oder das ganze Projekt) als WAV rendern
 *   2. Silenzium-CLI: Stille entfernen → ElevenLabs Voice Changer → Stille wieder einfügen
 *      (exakte Originallänge, Panning und Pegel des Originals)
 *   3. Ergebnis als neues Event auf der Spur „Anna_VC“ an derselben Position einfügen
 *
 * Einstellungen werden in %APPDATA%\Silenzium\vegas.ini gespeichert.
 * Installation: im Silenzium-Ordner „npm run vegas:install“ ausführen.
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;
using ScriptPortal.Vegas;

public class EntryPoint
{
    const string Title = "Silenzium";
    public const string VoiceSuffix = "_VC";
    const string LegacySuffix = " (Voice)"; // frühere Benennung, wird ebenfalls nicht als Original angeboten

    Vegas vegas;
    IniSettings settings;

    public void FromVegas(Vegas vegas)
    {
        this.vegas = vegas;
        try
        {
            Run();
        }
        catch (Exception e)
        {
            MessageBox.Show(e.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    // ------------------------------------------------------------------ Ablauf

    void Run()
    {
        settings = IniSettings.Load();
        string appDir = EnsureSilenziumDir();
        if (appDir == null) return;

        List<AudioTrack> originals = FindOriginalTracks();
        if (originals.Count == 0)
        {
            MessageBox.Show("Keine Audiospuren gefunden (Spuren mit der Endung \"" + VoiceSuffix + "\" werden ignoriert).", Title);
            return;
        }

        CliResult voiceList = RunCliCaptured(appDir, "voices");
        if (voiceList.ExitCode != 0)
        {
            MessageBox.Show("Die Voices konnten nicht geladen werden:\n\n" + voiceList.Error.Trim(), Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        List<VoiceItem> voices = VoiceItem.Parse(voiceList.Output);
        List<string> models = new List<string>();
        CliResult modelList = RunCliCaptured(appDir, "models");
        if (modelList.ExitCode == 0)
        {
            foreach (string line in SplitLines(modelList.Output)) models.Add(line.Split('\t')[0]);
        }

        List<RenderTemplate> templates = FindWavTemplates();
        if (templates.Count == 0) throw new ApplicationException("Keine WAV-Rendervorlage gefunden.");

        DialogInput input = new DialogInput();
        input.HasSelection = vegas.Transport.LoopRegionLength.Nanos > 0;
        input.SelectionText = vegas.Transport.LoopRegionStart.ToPositionString() + " – "
            + (vegas.Transport.LoopRegionStart + vegas.Transport.LoopRegionLength).ToPositionString();
        input.ProjectSampleRate = vegas.Project.Audio.SampleRate;
        foreach (AudioTrack t in originals) input.Tracks.Add(new TrackInfo(TrackName(t), t.Selected));
        foreach (RenderTemplate t in templates)
        {
            input.Templates.Add(new TemplateInfo(t.Name, t.AudioSampleRate, t.AudioChannelCount, t.AudioBitsPerSample));
        }

        ConvertDialog dialog = new ConvertDialog(input, settings, voices, models);
        if (dialog.ShowDialog() != DialogResult.OK) return;
        dialog.SaveTo(settings);
        settings.Save();

        foreach (TrackJob job in dialog.Jobs) job.Track = originals[job.TrackIndex];
        Execute(appDir, dialog.Jobs, templates[dialog.SelectedTemplateIndex], dialog.UseSelection, dialog.KeepFiles);
    }

    void Execute(string appDir, List<TrackJob> jobs, RenderTemplate template, bool useSelection, bool keepFiles)
    {
        Timecode start = useSelection ? vegas.Transport.LoopRegionStart : new Timecode(0.0);
        Timecode length = useSelection ? vegas.Transport.LoopRegionLength : vegas.Project.Length;
        if (length.Nanos <= 0) throw new ApplicationException("Der zu rendernde Bereich ist leer.");

        string workDir = CreateWorkDir();
        string ext = template.FileExtensions[0].Substring(1);

        // 1. Spuren einzeln rendern (Solo/Mute-Zustand wird danach wiederhergestellt)
        List<TrackState> states = TrackState.SaveAll(vegas.Project);
        try
        {
            foreach (TrackJob job in jobs)
            {
                string safe = SafeFileName(job.Name);
                job.InputFile = Path.Combine(workDir, safe + ext);
                job.OutputFile = Path.Combine(workDir, safe + "_voice.wav");

                foreach (Track t in vegas.Project.Tracks) t.Solo = false;
                job.Track.Solo = true;
                job.Track.Mute = false;

                RenderArgs args = new RenderArgs();
                args.OutputFile = job.InputFile;
                args.RenderTemplate = template;
                args.Start = start;
                args.Length = length;
                args.IncludeMarkers = false;
                RenderStatus status = vegas.Render(args);
                if (status == RenderStatus.Canceled) return;
                if (status != RenderStatus.Complete || !File.Exists(job.InputFile))
                {
                    throw new ApplicationException("Rendern von \"" + job.Name + "\" fehlgeschlagen (" + status + ").");
                }
            }
        }
        finally
        {
            TrackState.RestoreAll(states);
        }

        // 2. Silenzium-CLI im Konsolenfenster (zeigt den Fortschritt)
        string jobsFile = Path.Combine(workDir, "jobs.tsv");
        string settingsFile = Path.Combine(workDir, "settings.ini");
        string resultsFile = Path.Combine(workDir, "results.tsv");
        StringBuilder lines = new StringBuilder();
        foreach (TrackJob job in jobs)
        {
            lines.Append(job.InputFile).Append('\t').Append(job.OutputFile).Append('\t')
                 .Append(job.VoiceId).Append('\t').Append(job.Name).Append('\n');
        }
        File.WriteAllText(jobsFile, lines.ToString(), new UTF8Encoding(false));
        settings.WriteParams(settingsFile);

        string cliArgs = "batch --jobs " + Quote(jobsFile) + " --settings " + Quote(settingsFile)
                       + " --results " + Quote(resultsFile) + (keepFiles ? " --keep" : "");
        RunCliInConsole(appDir, cliArgs);

        // 3. Ergebnisse einfügen
        Dictionary<string, string[]> results = ReadResults(resultsFile);
        List<string> ok = new List<string>();
        List<string> failed = new List<string>();
        foreach (TrackJob job in jobs)
        {
            string[] r;
            if (results.TryGetValue(job.Name, out r) && r[1] == "ok" && File.Exists(job.OutputFile))
            {
                InsertResult(job, start);
                ok.Add(job.Name);
            }
            else
            {
                failed.Add(job.Name + ": " + (r != null && r.Length > 2 && r[2].Length > 0 ? r[2] : "keine Ausgabe"));
            }
        }
        vegas.UpdateUI();

        string summary = ok.Count + " von " + jobs.Count + " Spuren umgewandelt.";
        if (failed.Count > 0) summary += "\n\nFehler:\n" + string.Join("\n", failed.ToArray());
        summary += "\n\nDateien: " + workDir;
        MessageBox.Show(summary, Title, MessageBoxButtons.OK, failed.Count > 0 ? MessageBoxIcon.Warning : MessageBoxIcon.Information);
    }

    void InsertResult(TrackJob job, Timecode start)
    {
        AudioTrack target = FindOrCreateVoiceTrack(job.Track);
        Media media = vegas.Project.MediaPool.AddMedia(job.OutputFile);
        AudioStream stream = media.GetAudioStreamByIndex(0);
        AudioEvent ev = target.AddAudioEvent(start, media.Length);
        ev.AddTake(stream, true, Path.GetFileNameWithoutExtension(job.OutputFile) + " " + job.VoiceName);
    }

    AudioTrack FindOrCreateVoiceTrack(AudioTrack original)
    {
        string name = TrackName(original) + VoiceSuffix;
        foreach (Track t in vegas.Project.Tracks)
        {
            if (t.IsAudio() && t.Name == name) return (AudioTrack)t;
        }
        AudioTrack track = new AudioTrack(vegas.Project, original.Index + 1, name);
        vegas.Project.Tracks.Add(track);
        return track;
    }

    // ------------------------------------------------------------------ Hilfen

    List<AudioTrack> FindOriginalTracks()
    {
        List<AudioTrack> list = new List<AudioTrack>();
        foreach (Track t in vegas.Project.Tracks)
        {
            string name = TrackName(t);
            if (t.IsAudio() && !name.EndsWith(VoiceSuffix) && !name.EndsWith(LegacySuffix)) list.Add((AudioTrack)t);
        }
        return list;
    }

    public static string TrackName(Track t)
    {
        return string.IsNullOrEmpty(t.Name) ? "Spur " + (t.Index + 1) : t.Name;
    }

    List<RenderTemplate> FindWavTemplates()
    {
        List<RenderTemplate> list = new List<RenderTemplate>();
        foreach (Renderer renderer in vegas.Renderers)
        {
            bool wav = false;
            foreach (string e in renderer.FileExtensions) if (e.ToLowerInvariant() == "*.wav") wav = true;
            if (!wav) continue;
            foreach (RenderTemplate t in renderer.Templates)
            {
                if (t.IsValid() && t.AudioStreamCount > 0) list.Add(t);
            }
        }
        return list;
    }

    string CreateWorkDir()
    {
        string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        string root;
        string projectPath = vegas.Project.FilePath;
        if (!string.IsNullOrEmpty(projectPath))
        {
            root = Path.Combine(Path.Combine(Path.GetDirectoryName(projectPath), "Silenzium"),
                                Path.GetFileNameWithoutExtension(projectPath) + "_" + stamp);
        }
        else
        {
            root = Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Silenzium"), stamp);
        }
        Directory.CreateDirectory(root);
        return root;
    }

    string EnsureSilenziumDir()
    {
        string dir = settings.Get("silenziumDir", "");
        while (!File.Exists(Path.Combine(dir, Path.Combine("cli", "silenzium.js"))))
        {
            FolderBrowserDialog fb = new FolderBrowserDialog();
            fb.Description = "Silenzium-Ordner auswählen (enthält cli\\silenzium.js)";
            if (fb.ShowDialog() != DialogResult.OK) return null;
            dir = fb.SelectedPath;
        }
        settings.Set("silenziumDir", dir);
        return dir;
    }

    string NodePath()
    {
        return settings.Get("nodePath", "node");
    }

    CliResult RunCliCaptured(string appDir, string args)
    {
        ProcessStartInfo psi = new ProcessStartInfo(NodePath(), Quote(Path.Combine(appDir, "cli\\silenzium.js")) + " " + args);
        psi.WorkingDirectory = appDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        CliResult result = new CliResult();
        try
        {
            Cursor.Current = Cursors.WaitCursor;
            using (Process p = Process.Start(psi))
            {
                result.Output = p.StandardOutput.ReadToEnd();
                result.Error = p.StandardError.ReadToEnd();
                p.WaitForExit();
                result.ExitCode = p.ExitCode;
            }
        }
        catch (Exception e)
        {
            result.ExitCode = -1;
            result.Error = "Node.js konnte nicht gestartet werden (" + NodePath() + "): " + e.Message;
        }
        finally
        {
            Cursor.Current = Cursors.Default;
        }
        return result;
    }

    void RunCliInConsole(string appDir, string args)
    {
        string command = "/c title Silenzium & chcp 65001 >nul & " + Quote(NodePath()) + " "
                       + Quote(Path.Combine(appDir, "cli\\silenzium.js")) + " " + args
                       + " & if errorlevel 1 (echo. & echo Fenster mit einer Taste schliessen. & pause >nul)";
        ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", command);
        psi.WorkingDirectory = appDir;
        psi.UseShellExecute = false;
        using (Process p = Process.Start(psi))
        {
            p.WaitForExit();
        }
    }

    static Dictionary<string, string[]> ReadResults(string file)
    {
        Dictionary<string, string[]> map = new Dictionary<string, string[]>();
        if (!File.Exists(file)) return map;
        foreach (string line in SplitLines(File.ReadAllText(file, Encoding.UTF8)))
        {
            string[] parts = line.Split('\t');
            if (parts.Length >= 2) map[parts[0]] = parts;
        }
        return map;
    }

    public static string[] SplitLines(string text)
    {
        return text.Replace("\r", "").Split(new char[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
    }

    static string Quote(string s)
    {
        return "\"" + s + "\"";
    }

    static string SafeFileName(string name)
    {
        foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        return name;
    }
}

// ---------------------------------------------------------------------- Datenklassen

public class TrackJob
{
    public int TrackIndex;
    public AudioTrack Track;
    public string Name;
    public string VoiceId;
    public string VoiceName;
    public string InputFile;
    public string OutputFile;
}

public class CliResult
{
    public int ExitCode;
    public string Output = "";
    public string Error = "";
}

public class TrackState
{
    Track track;
    bool solo;
    bool mute;

    public static List<TrackState> SaveAll(Project project)
    {
        List<TrackState> list = new List<TrackState>();
        foreach (Track t in project.Tracks)
        {
            TrackState s = new TrackState();
            s.track = t;
            s.solo = t.Solo;
            s.mute = t.Mute;
            list.Add(s);
        }
        return list;
    }

    public static void RestoreAll(List<TrackState> states)
    {
        foreach (TrackState s in states)
        {
            s.track.Solo = s.solo;
            s.track.Mute = s.mute;
        }
    }
}

public class VoiceItem
{
    public string Id;
    public string Name;
    public string Group;
    public string Display;

    public override string ToString() { return Display; }

    /** TSV von „silenzium voices“: Gruppe ⇥ ID ⇥ Name ⇥ Kategorie */
    public static List<VoiceItem> Parse(string tsv)
    {
        List<VoiceItem> list = new List<VoiceItem>();
        Dictionary<string, int> seen = new Dictionary<string, int>();
        foreach (string line in EntryPoint.SplitLines(tsv))
        {
            string[] p = line.Split('\t');
            if (p.Length < 3) continue;
            VoiceItem v = new VoiceItem();
            v.Group = p[0];
            v.Id = p[1];
            v.Name = p[2];
            v.Display = p[2] + (p[0] == "saved" ? " (gespeichert)" : "");
            if (seen.ContainsKey(v.Display)) v.Display += " [" + v.Id.Substring(0, Math.Min(6, v.Id.Length)) + "]";
            seen[v.Display] = 1;
            list.Add(v);
        }
        return list;
    }
}

public class Choice
{
    public string Value;
    public string Text;
    public Choice(string value, string text) { Value = value; Text = text; }
    public override string ToString() { return Text; }
}

// ---------------------------------------------------------------------- Einstellungen

public class IniSettings
{
    static readonly string[] ParamKeys = {
        "autoThreshold", "thresholdDb", "preMs", "postMs", "minSilenceMs", "minSoundMs", "windowMs", "fadeMs",
        "panMode", "levelMode", "elModelId", "elOutputFormat", "elRemoveNoise", "elAutoAlign", "elSeed", "elChunkSec",
    };

    Dictionary<string, string> values = new Dictionary<string, string>();

    static string FilePath()
    {
        return Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Silenzium"), "vegas.ini");
    }

    public static IniSettings Load()
    {
        IniSettings s = new IniSettings();
        string file = FilePath();
        if (File.Exists(file))
        {
            foreach (string line in EntryPoint.SplitLines(File.ReadAllText(file, Encoding.UTF8)))
            {
                int eq = line.IndexOf('=');
                if (eq > 0 && !line.StartsWith("#")) s.values[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
            }
        }
        return s;
    }

    public void Save()
    {
        string file = FilePath();
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        StringBuilder sb = new StringBuilder("# Silenzium – Einstellungen des Vegas-Skripts\n");
        List<string> keys = new List<string>(values.Keys);
        keys.Sort(StringComparer.Ordinal);
        foreach (string k in keys) sb.Append(k).Append('=').Append(values[k]).Append('\n');
        File.WriteAllText(file, sb.ToString(), new UTF8Encoding(false));
    }

    /** Nur die Verarbeitungs-Parameter, als key=value-Datei für das CLI. */
    public void WriteParams(string file)
    {
        StringBuilder sb = new StringBuilder();
        foreach (string k in ParamKeys)
        {
            if (values.ContainsKey(k)) sb.Append(k).Append('=').Append(values[k]).Append('\n');
        }
        File.WriteAllText(file, sb.ToString(), new UTF8Encoding(false));
    }

    public string Get(string key, string fallback)
    {
        string v;
        return values.TryGetValue(key, out v) ? v : fallback;
    }

    public bool GetBool(string key, bool fallback)
    {
        string v = Get(key, fallback ? "true" : "false");
        return v == "true" || v == "1";
    }

    public decimal GetDecimal(string key, decimal fallback)
    {
        decimal d;
        return decimal.TryParse(Get(key, ""), System.Globalization.NumberStyles.Number,
                                System.Globalization.CultureInfo.InvariantCulture, out d) ? d : fallback;
    }

    public void Set(string key, string value) { values[key] = value; }
    public void Set(string key, bool value) { values[key] = value ? "true" : "false"; }
    public void Set(string key, decimal value) { values[key] = value.ToString(System.Globalization.CultureInfo.InvariantCulture); }
}

// ---------------------------------------------------------------------- Dialog

public class ConvertDialog : Form
{
    public List<TrackJob> Jobs = new List<TrackJob>();
    public int SelectedTemplateIndex = -1;
    public bool UseSelection;
    public bool KeepFiles;

    DialogInput input;
    List<VoiceItem> voices;

    DataGridView grid = new DataGridView();
    CheckBox selectionBox = new CheckBox();
    CheckBox autoThreshold = new CheckBox();
    NumericUpDown threshold = Num(-120, 0, 1);
    NumericUpDown preMs = Num(0, 5000, 0);
    NumericUpDown postMs = Num(0, 5000, 0);
    NumericUpDown minSilence = Num(0, 10000, 0);
    NumericUpDown minSound = Num(0, 5000, 0);
    NumericUpDown fadeMs = Num(0, 50, 0);
    ComboBox panMode = new ComboBox();
    ComboBox levelMode = new ComboBox();
    ComboBox model = new ComboBox();
    ComboBox outputFormat = new ComboBox();
    CheckBox removeNoise = new CheckBox();
    CheckBox autoAlign = new CheckBox();
    TextBox seed = new TextBox();
    NumericUpDown chunkSec = Num(10, 300, 0);
    ComboBox template = new ComboBox();
    CheckBox keepFiles = new CheckBox();

    public ConvertDialog(DialogInput input, IniSettings s, List<VoiceItem> voices, List<string> models)
    {
        this.input = input;
        this.voices = voices;

        Text = "Silenzium – Stimmen umwandeln";
        FormBorderStyle = FormBorderStyle.Sizable;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        AutoScaleMode = AutoScaleMode.Font;
        Font = new Font("Segoe UI", 9F);
        ClientSize = new Size(760, 720);
        MinimumSize = new Size(640, 600);

        TableLayoutPanel root = new TableLayoutPanel();
        root.Dock = DockStyle.Fill;
        root.Padding = new Padding(10);
        root.ColumnCount = 1;
        root.RowCount = 5;
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Controls.Add(root);

        // Bereich
        selectionBox.AutoSize = true;
        selectionBox.Enabled = input.HasSelection;
        selectionBox.Checked = input.HasSelection && s.GetBool("useSelection", true);
        selectionBox.Text = input.HasSelection
            ? "Nur Zeitauswahl umwandeln (" + input.SelectionText + ")"
            : "Nur Zeitauswahl umwandeln (keine Auswahl vorhanden – es wird das ganze Projekt verwendet)";
        selectionBox.Margin = new Padding(3, 3, 3, 8);
        root.Controls.Add(selectionBox);

        // Spuren
        BuildGrid(s);
        root.Controls.Add(grid);

        // Einstellungen
        GroupBox group = new GroupBox();
        group.Text = "Einstellungen (für alle Spuren)";
        group.Dock = DockStyle.Fill;
        group.AutoSize = true;
        group.Padding = new Padding(8);
        TableLayoutPanel p = new TableLayoutPanel();
        p.Dock = DockStyle.Fill;
        p.AutoSize = true;
        p.ColumnCount = 4;
        p.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        p.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        p.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        p.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        group.Controls.Add(p);
        root.Controls.Add(group);

        autoThreshold.Text = "automatisch (Grundrauschen)";
        autoThreshold.AutoSize = true;
        autoThreshold.CheckedChanged += delegate { threshold.Enabled = !autoThreshold.Checked; };
        AddRow(p, "Threshold (dBFS)", threshold, "", autoThreshold);
        AddRow(p, "Pre (ms)", preMs, "Post (ms)", postMs);
        AddRow(p, "Min. Stille (ms)", minSilence, "Min. Geräusch (ms)", minSound);
        AddRow(p, "Blende an Schnitten (ms)", fadeMs, "Max. Länge je Anfrage (s)", chunkSec);

        Fill(panMode, new Choice[] {
            new Choice("global", "Panning des Originals"),
            new Choice("segment", "Panning je Passage"),
            new Choice("off", "gleich auf beide Kanäle") });
        Fill(levelMode, new Choice[] {
            new Choice("global", "ganze Datei"),
            new Choice("segment", "je Passage"),
            new Choice("off", "nicht anpassen") });
        AddRow(p, "Mono → Stereo", panMode, "Pegel an Original", levelMode);

        model.DropDownStyle = ComboBoxStyle.DropDown;
        foreach (string m in models) model.Items.Add(m);
        Fill(outputFormat, new Choice[] {
            new Choice("mp3_44100_128", "MP3 44,1 kHz 128 kbit/s"),
            new Choice("pcm_24000", "PCM 24 kHz (verlustfrei)"),
            new Choice("wav_24000", "WAV 24 kHz (verlustfrei)"),
            new Choice("mp3_44100_192", "MP3 44,1 kHz 192 kbit/s (ab Creator)"),
            new Choice("pcm_44100", "PCM 44,1 kHz (ab Pro)") });
        AddRow(p, "Modell", model, "Ausgabeformat", outputFormat);

        removeNoise.Text = "Hintergrundgeräusche entfernen";
        removeNoise.AutoSize = true;
        autoAlign.Text = "Versatz automatisch ausgleichen";
        autoAlign.AutoSize = true;
        AddRow(p, "Seed (optional)", seed, "", Stack(removeNoise, autoAlign));

        template.DropDownStyle = ComboBoxStyle.DropDownList;
        foreach (TemplateInfo t in input.Templates) template.Items.Add(t);
        keepFiles.Text = "Zwischendateien speichern";
        keepFiles.AutoSize = true;
        AddRow(p, "WAV-Rendervorlage", template, "", keepFiles);

        // Hinweis + Schaltflächen
        Label hint = new Label();
        hint.AutoSize = true;
        hint.MaximumSize = new Size(720, 0);
        hint.ForeColor = SystemColors.GrayText;
        hint.Margin = new Padding(3, 8, 3, 3);
        hint.Text = "Jede gewählte Spur wird solo gerendert, von ElevenLabs umgewandelt und als neues Event auf der Spur „<Name>"
                  + EntryPoint.VoiceSuffix + "“ eingefügt (wird bei Bedarf angelegt). Credits: ca. 1.000 je Minute nicht-stillem Audio.";
        root.Controls.Add(hint);

        FlowLayoutPanel buttons = new FlowLayoutPanel();
        buttons.FlowDirection = FlowDirection.RightToLeft;
        buttons.Dock = DockStyle.Fill;
        buttons.AutoSize = true;
        Button cancel = new Button();
        cancel.Text = "Abbrechen";
        cancel.DialogResult = DialogResult.Cancel;
        Button ok = new Button();
        ok.Text = "Umwandeln";
        ok.AutoSize = true;
        ok.Click += HandleOk;
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(ok);
        root.Controls.Add(buttons);
        AcceptButton = ok;
        CancelButton = cancel;

        LoadFrom(s);
    }

    void BuildGrid(IniSettings s)
    {
        grid.Dock = DockStyle.Fill;
        grid.AllowUserToAddRows = false;
        grid.AllowUserToDeleteRows = false;
        grid.RowHeadersVisible = false;
        grid.SelectionMode = DataGridViewSelectionMode.CellSelect;
        grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        grid.EditMode = DataGridViewEditMode.EditOnEnter;
        grid.MinimumSize = new Size(0, 160);
        grid.BackgroundColor = SystemColors.Window;
        grid.BorderStyle = BorderStyle.FixedSingle;

        DataGridViewCheckBoxColumn use = new DataGridViewCheckBoxColumn();
        use.HeaderText = "Umwandeln";
        use.FillWeight = 18;
        DataGridViewTextBoxColumn name = new DataGridViewTextBoxColumn();
        name.HeaderText = "Spur";
        name.ReadOnly = true;
        name.FillWeight = 40;
        DataGridViewComboBoxColumn voice = new DataGridViewComboBoxColumn();
        voice.HeaderText = "Voice";
        voice.FillWeight = 60;
        voice.FlatStyle = FlatStyle.Flat;
        voice.Items.Add("");
        foreach (VoiceItem v in voices) voice.Items.Add(v.Display);
        grid.Columns.Add(use);
        grid.Columns.Add(name);
        grid.Columns.Add(voice);

        bool anySelected = false;
        foreach (TrackInfo t in input.Tracks) if (t.Selected) anySelected = true;

        foreach (TrackInfo t in input.Tracks)
        {
            VoiceItem item = FindVoice(s.Get("voice." + t.Name, ""));
            bool check = anySelected ? t.Selected : item != null;
            grid.Rows.Add(check, t.Name, item != null ? item.Display : "");
        }
        // Häkchen sofort übernehmen (nicht erst beim Verlassen der Zelle)
        grid.CurrentCellDirtyStateChanged += delegate
        {
            if (grid.IsCurrentCellDirty) grid.CommitEdit(DataGridViewDataErrorContexts.Commit);
        };
    }

    VoiceItem FindVoice(string idOrDisplay)
    {
        foreach (VoiceItem v in voices) if (v.Id == idOrDisplay || v.Display == idOrDisplay) return v;
        return null;
    }

    void LoadFrom(IniSettings s)
    {
        autoThreshold.Checked = s.GetBool("autoThreshold", false);
        threshold.Value = Clamp(threshold, s.GetDecimal("thresholdDb", -80));
        threshold.Enabled = !autoThreshold.Checked;
        preMs.Value = Clamp(preMs, s.GetDecimal("preMs", 100));
        postMs.Value = Clamp(postMs, s.GetDecimal("postMs", 150));
        minSilence.Value = Clamp(minSilence, s.GetDecimal("minSilenceMs", 250));
        minSound.Value = Clamp(minSound, s.GetDecimal("minSoundMs", 30));
        fadeMs.Value = Clamp(fadeMs, s.GetDecimal("fadeMs", 5));
        chunkSec.Value = Clamp(chunkSec, s.GetDecimal("elChunkSec", 240));
        Select(panMode, s.Get("panMode", "global"));
        Select(levelMode, s.Get("levelMode", "segment"));
        model.Text = s.Get("elModelId", "eleven_multilingual_sts_v2");
        Select(outputFormat, s.Get("elOutputFormat", "mp3_44100_128"));
        removeNoise.Checked = s.GetBool("elRemoveNoise", false);
        autoAlign.Checked = s.GetBool("elAutoAlign", true);
        seed.Text = s.Get("elSeed", "");
        keepFiles.Checked = s.GetBool("keepFiles", false);

        // Rendervorlage: gespeicherte, sonst passend zur Projekt-Samplerate (Stereo, höchste Bittiefe)
        string saved = s.Get("renderTemplate", "");
        int best = -1;
        int bestScore = int.MinValue;
        for (int i = 0; i < input.Templates.Count; i++)
        {
            TemplateInfo t = input.Templates[i];
            if (t.Name == saved) { best = i; break; }
            int score = (t.SampleRate == input.ProjectSampleRate ? 1000 : 0) + (t.Channels == 2 ? 100 : 0) + t.Bits;
            if (score > bestScore) { bestScore = score; best = i; }
        }
        if (best >= 0) template.SelectedIndex = best;
    }

    public void SaveTo(IniSettings s)
    {
        s.Set("useSelection", selectionBox.Checked);
        s.Set("autoThreshold", autoThreshold.Checked);
        s.Set("thresholdDb", threshold.Value);
        s.Set("preMs", preMs.Value);
        s.Set("postMs", postMs.Value);
        s.Set("minSilenceMs", minSilence.Value);
        s.Set("minSoundMs", minSound.Value);
        s.Set("fadeMs", fadeMs.Value);
        s.Set("elChunkSec", chunkSec.Value);
        s.Set("panMode", ((Choice)panMode.SelectedItem).Value);
        s.Set("levelMode", ((Choice)levelMode.SelectedItem).Value);
        s.Set("elModelId", model.Text.Trim());
        s.Set("elOutputFormat", ((Choice)outputFormat.SelectedItem).Value);
        s.Set("elRemoveNoise", removeNoise.Checked);
        s.Set("elAutoAlign", autoAlign.Checked);
        s.Set("elSeed", seed.Text.Trim());
        s.Set("keepFiles", keepFiles.Checked);
        s.Set("renderTemplate", input.Templates[SelectedTemplateIndex].Name);
        foreach (DataGridViewRow row in grid.Rows)
        {
            VoiceItem v = FindVoice(Convert.ToString(row.Cells[2].Value));
            if (v != null) s.Set("voice." + Convert.ToString(row.Cells[1].Value), v.Id);
        }
    }

    void HandleOk(object sender, EventArgs e)
    {
        grid.EndEdit();
        Jobs.Clear();
        for (int i = 0; i < grid.Rows.Count; i++)
        {
            DataGridViewRow row = grid.Rows[i];
            if (!Convert.ToBoolean(row.Cells[0].Value)) continue;
            VoiceItem v = FindVoice(Convert.ToString(row.Cells[2].Value));
            if (v == null)
            {
                MessageBox.Show("Bitte für die Spur \"" + row.Cells[1].Value + "\" eine Voice wählen.", Text);
                return;
            }
            TrackJob job = new TrackJob();
            job.TrackIndex = i;
            job.Name = Convert.ToString(row.Cells[1].Value);
            job.VoiceId = v.Id;
            job.VoiceName = v.Name;
            Jobs.Add(job);
        }
        if (Jobs.Count == 0)
        {
            MessageBox.Show("Bitte mindestens eine Spur zum Umwandeln auswählen.", Text);
            return;
        }
        long parsed;
        if (seed.Text.Trim().Length > 0 && (!long.TryParse(seed.Text.Trim(), out parsed) || parsed < 0 || parsed > 4294967295L))
        {
            MessageBox.Show("Seed muss leer sein oder eine Zahl von 0 bis 4294967295.", Text);
            return;
        }
        if (template.SelectedItem == null || panMode.SelectedItem == null || levelMode.SelectedItem == null || outputFormat.SelectedItem == null)
        {
            MessageBox.Show("Bitte alle Einstellungen auswählen.", Text);
            return;
        }
        SelectedTemplateIndex = template.SelectedIndex;
        UseSelection = selectionBox.Checked;
        KeepFiles = keepFiles.Checked;
        DialogResult = DialogResult.OK;
        Close();
    }

    // ------------------------------------------------------------------ Layout-Hilfen

    static NumericUpDown Num(int min, int max, int decimals)
    {
        NumericUpDown n = new NumericUpDown();
        n.Minimum = min;
        n.Maximum = max;
        n.DecimalPlaces = decimals;
        n.Increment = decimals > 0 ? 0.5M : 10;
        n.Anchor = AnchorStyles.Left;
        n.Width = 90;
        return n;
    }

    static decimal Clamp(NumericUpDown n, decimal v)
    {
        return Math.Max(n.Minimum, Math.Min(n.Maximum, v));
    }

    static void Fill(ComboBox box, Choice[] choices)
    {
        box.DropDownStyle = ComboBoxStyle.DropDownList;
        foreach (Choice c in choices) box.Items.Add(c);
    }

    static void Select(ComboBox box, string value)
    {
        for (int i = 0; i < box.Items.Count; i++)
        {
            Choice c = box.Items[i] as Choice;
            if (c != null && c.Value == value) { box.SelectedIndex = i; return; }
        }
        if (box.Items.Count > 0) box.SelectedIndex = 0;
    }

    static Control Stack(Control a, Control b)
    {
        FlowLayoutPanel f = new FlowLayoutPanel();
        f.FlowDirection = FlowDirection.TopDown;
        f.AutoSize = true;
        f.Margin = new Padding(0);
        f.Controls.Add(a);
        f.Controls.Add(b);
        return f;
    }

    static void AddRow(TableLayoutPanel p, string label1, Control c1, string label2, Control c2)
    {
        p.Controls.Add(MakeLabel(label1));
        if (c1 is ComboBox || c1 is TextBox) c1.Dock = DockStyle.Fill;
        p.Controls.Add(c1);
        p.Controls.Add(MakeLabel(label2));
        if (c2 == null) c2 = new Label();
        if (c2 is ComboBox || c2 is TextBox) c2.Dock = DockStyle.Fill;
        p.Controls.Add(c2);
    }

    static Label MakeLabel(string text)
    {
        Label l = new Label();
        l.Text = text;
        l.AutoSize = true;
        l.Anchor = AnchorStyles.Left;
        l.Margin = new Padding(3, 7, 8, 3);
        return l;
    }
}

/** Daten für den Dialog – bewusst ohne Vegas-Typen, damit er auch außerhalb von Vegas testbar ist. */
public class DialogInput
{
    public bool HasSelection;
    public string SelectionText = "";
    public uint ProjectSampleRate;
    public List<TrackInfo> Tracks = new List<TrackInfo>();
    public List<TemplateInfo> Templates = new List<TemplateInfo>();
}

public class TrackInfo
{
    public string Name;
    public bool Selected;
    public TrackInfo(string name, bool selected) { Name = name; Selected = selected; }
}

public class TemplateInfo
{
    public string Name;
    public uint SampleRate;
    public int Channels;
    public int Bits;
    public TemplateInfo(string name, uint sampleRate, int channels, int bits)
    {
        Name = name; SampleRate = sampleRate; Channels = channels; Bits = bits;
    }
    public override string ToString() { return Name; }
}
