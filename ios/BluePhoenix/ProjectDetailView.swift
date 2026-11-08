import SwiftUI

private enum Section: String, CaseIterable, Identifiable {
    case todos = "To-dos", notes = "Notes", time = "Time", commands = "Commands", git = "Git"
    var id: String { rawValue }
}

struct ProjectDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let projectId: String
    @State private var section: Section = .todos
    @State private var editing = false
    @State private var confirmDelete = false

    var body: some View {
        Group {
            if let p = store.project(projectId) {
                VStack(spacing: 0) {
                    header(p)
                    Picker("Section", selection: $section) {
                        // Git only appears once a computer has shared a summary for this project.
                        ForEach(Section.allCases.filter { $0 != .git || store.git(p.id) != nil }) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding([.horizontal, .bottom])
                    switch section {
                    case .todos: TodosSection(project: p)
                    case .notes: NotesSection(project: p)
                    case .time: TimeSection(project: p)
                    case .commands: CommandsSection(project: p)
                    case .git: GitSection(project: p)
                    }
                }
                .background(BrandBackground())
                .navigationTitle(p.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { var q = p; q.favorite.toggle(); store.save(q) } label: {
                            Image(systemName: p.favorite ? "star.fill" : "star").foregroundStyle(p.favorite ? .yellow : .accentColor)
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button { editing = true } label: { Label("Edit project", systemImage: "pencil") }
                            if p.archivedAt == nil {
                                Button { store.setArchived(p, true); dismiss() } label: { Label("Archive project", systemImage: "archivebox") }
                            } else {
                                Button { store.setArchived(p, false) } label: { Label("Restore from archive", systemImage: "arrow.uturn.backward") }
                            }
                            Button(role: .destructive) { confirmDelete = true } label: { Label("Delete project", systemImage: "trash") }
                        } label: { Image(systemName: "ellipsis.circle") }
                    }
                }
                .sheet(isPresented: $editing) { ProjectEditor(project: p) }
                .confirmationDialog("Delete \(p.name) and all its to-dos, notes and time? This syncs to your other devices.", isPresented: $confirmDelete, titleVisibility: .visible) {
                    Button("Delete project", role: .destructive) { store.delete(p); dismiss() }
                }
            } else {
                ContentUnavailableView("Project not found", systemImage: "questionmark.folder")
                    .onAppear { dismiss() }
            }
        }
    }

    @ViewBuilder private func header(_ p: Project) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Pill(text: p.kind)
                Label(formatMinutes(store.minutes(p.id)), systemImage: "clock").font(.footnote).foregroundStyle(.secondary)
                Label("\(store.openTodos(p.id)) open", systemImage: "checklist").font(.footnote).foregroundStyle(.secondary)
                Spacer()
                if let g = p.githubUrl, let u = URL(string: g) { Link(destination: u) { Image(systemName: "chevron.left.forwardslash.chevron.right") } }
                if let w = p.websiteUrl, let u = URL(string: w) { Link(destination: u) { Image(systemName: "globe") } }
            }
            if let d = p.description, !d.isEmpty { Text(d).font(.subheadline).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal).padding(.vertical, 8)
    }
}

// MARK: - Project editor

private struct ProjectEditor: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State var project: Project
    @State private var description: String
    @State private var github: String
    @State private var website: String

    init(project: Project) {
        _project = State(initialValue: project)
        _description = State(initialValue: project.description ?? "")
        _github = State(initialValue: project.githubUrl ?? "")
        _website = State(initialValue: project.websiteUrl ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section("Project") {
                    TextField("Name", text: $project.name)
                    TextField("Type (e.g. Tauri, Course)", text: $project.kind)
                    Toggle("Favorite", isOn: $project.favorite)
                }
                SwiftUI.Section("Description") {
                    TextField("Optional", text: $description, axis: .vertical).lineLimit(2...6)
                }
                SwiftUI.Section("Links") {
                    TextField("GitHub URL", text: $github).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Website", text: $website).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            }
            .navigationTitle("Edit project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var p = project
                        p.name = p.name.trimmingCharacters(in: .whitespaces)
                        p.kind = p.kind.trimmingCharacters(in: .whitespaces).isEmpty ? "Other" : p.kind.trimmingCharacters(in: .whitespaces)
                        p.description = description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : description.trimmingCharacters(in: .whitespacesAndNewlines)
                        p.githubUrl = github.trimmingCharacters(in: .whitespaces).isEmpty ? nil : github.trimmingCharacters(in: .whitespaces)
                        p.websiteUrl = website.trimmingCharacters(in: .whitespaces).isEmpty ? nil : website.trimmingCharacters(in: .whitespaces)
                        if !p.name.isEmpty { store.save(p) }
                        dismiss()
                    }
                    .disabled(project.name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

// MARK: - To-dos

private struct TodosSection: View {
    @Environment(AppStore.self) private var store
    let project: Project
    @State private var draft = ""
    @State private var editing: Todo?

    var body: some View {
        let todos = store.todos(project.id)
        let open = todos.filter { !$0.isDone }
        let done = todos.filter(\.isDone)
        List {
            SwiftUI.Section {
                HStack {
                    TextField("Add a to-do", text: $draft).submitLabel(.done).onSubmit(add)
                    Button("Add", action: add).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }.glassRow()
            if !open.isEmpty {
                SwiftUI.Section("Open") { ForEach(open) { row($0) } }
            }
            if !done.isEmpty {
                SwiftUI.Section("Completed") { ForEach(done) { row($0) } }
            }
        }
        .brandList()
        .overlay { if todos.isEmpty { ContentUnavailableView("No to-dos", systemImage: "checklist", description: Text("Add one above.")) } }
        .sheet(item: $editing) { TodoEditor(todo: $0) }
    }

    private func add() {
        let t = draft.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        store.addTodo(t, to: project.id)
        draft = ""
    }

    private func row(_ t: Todo) -> some View {
        HStack(spacing: 12) {
            Button {
                var q = t; q.status = t.isDone ? "todo" : "done"; store.save(q)
            } label: {
                Image(systemName: t.isDone ? "checkmark.circle.fill" : (t.status == "doing" ? "circle.dotted.circle" : "circle"))
                    .font(.title3).foregroundStyle(t.isDone ? .green : (t.status == "doing" ? .blue : .secondary))
            }.buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 2) {
                Text(t.title).strikethrough(t.isDone).foregroundStyle(t.isDone ? .secondary : .primary)
                if !t.notes.isEmpty { Text(t.notes).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer()
            if t.priority > 0 {
                Pill(text: ["", "Low", "Medium", "High"][Int(min(t.priority, 3))], color: [.gray, .blue, .orange, .red][Int(min(t.priority, 3))])
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { editing = t }
        .glassRow()
        .swipeActions { Button(role: .destructive) { store.delete(t) } label: { Label("Delete", systemImage: "trash") } }
    }
}

private struct TodoEditor: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State var todo: Todo
    @State private var hasDue = false
    @State private var due = Date()

    init(todo: Todo) {
        _todo = State(initialValue: todo)
        _hasDue = State(initialValue: todo.due != nil)
        _due = State(initialValue: todo.due.map { Date(timeIntervalSince1970: Double($0) / 1000) } ?? Date())
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $todo.title)
                Picker("Status", selection: $todo.status) {
                    Text("To do").tag("todo"); Text("In progress").tag("doing"); Text("Done").tag("done")
                }
                Picker("Priority", selection: $todo.priority) {
                    Text("None").tag(Int64(0)); Text("Low").tag(Int64(1)); Text("Medium").tag(Int64(2)); Text("High").tag(Int64(3))
                }
                Toggle("Due date", isOn: $hasDue)
                if hasDue { DatePicker("Due", selection: $due, displayedComponents: .date) }
                SwiftUI.Section("Notes (Markdown)") {
                    TextEditor(text: $todo.notes).frame(minHeight: 140)
                }
                if let p = todo.aiPrompt, !p.isEmpty {
                    SwiftUI.Section("AI prompt") {
                        Text(p).font(.footnote.monospaced())
                        Button("Copy prompt") { UIPasteboard.general.string = p }
                    }
                }
                SwiftUI.Section {
                    Button("Delete to-do", role: .destructive) { store.delete(todo); dismiss() }
                }
            }
            .navigationTitle("To-do")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var t = todo
                        t.title = t.title.trimmingCharacters(in: .whitespaces)
                        t.due = hasDue ? Int64(due.timeIntervalSince1970 * 1000) : nil
                        if !t.title.isEmpty { store.save(t) }
                        dismiss()
                    }
                }
            }
        }
    }
}

// MARK: - Notes

private struct NotesSection: View {
    @Environment(AppStore.self) private var store
    let project: Project
    @State private var adding = false
    @State private var title = ""

    var body: some View {
        let pages = store.pages(project.id)
        List {
            ForEach(pages) { page in
                NavigationLink { PageEditor(page: page) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(page.title).font(.headline)
                        Text(page.markdown.isEmpty ? "Empty" : page.markdown).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                .glassRow()
                .swipeActions { Button(role: .destructive) { store.delete(page) } label: { Label("Delete", systemImage: "trash") } }
            }
        }
        .brandList()
        .overlay { if pages.isEmpty { ContentUnavailableView("No pages", systemImage: "doc.text", description: Text("Pages hold Markdown notes for this project.")) } }
        .toolbar { ToolbarItem(placement: .bottomBar) { Button { title = ""; adding = true } label: { Label("New page", systemImage: "plus") } } }
        .alert("New page", isPresented: $adding) {
            TextField("Title", text: $title)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let t = title.trimmingCharacters(in: .whitespaces)
                if !t.isEmpty { store.save(TodoPage(projectId: project.id, title: t, sort: Int64(pages.count))) }
            }
        }
    }
}

private struct PageEditor: View {
    @Environment(AppStore.self) private var store
    @State var page: TodoPage
    @State private var preview = false
    @State private var renaming = false
    @State private var renameText = ""

    var body: some View {
        VStack {
            if preview {
                ScrollView {
                    Text((try? AttributedString(markdown: page.markdown, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(page.markdown))
                        .frame(maxWidth: .infinity, alignment: .leading).padding()
                }
            } else {
                TextEditor(text: $page.markdown).padding(.horizontal, 8).scrollContentBackground(.hidden)
            }
        }
        .background(BrandBackground())
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(preview ? "Edit" : "Preview") { preview.toggle() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { renameText = page.title; renaming = true } label: { Image(systemName: "pencil") }
            }
        }
        .alert("Rename page", isPresented: $renaming) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                let t = renameText.trimmingCharacters(in: .whitespaces)
                if !t.isEmpty { page.title = t }
            }
        }
        .onDisappear { store.save(page) }
    }
}

// MARK: - Time

private struct TimeSection: View {
    @Environment(AppStore.self) private var store
    let project: Project
    @State private var note = ""
    private let quick: [(Int64, String)] = [(10, "10 min"), (15, "15 min"), (30, "30 min"), (60, "1 hour"), (120, "2 hours"), (180, "3 hours")]

    var body: some View {
        let entries = store.time(project.id)
        let groups = Dictionary(grouping: entries) { Calendar.current.startOfDay(for: Date(timeIntervalSince1970: Double($0.loggedAt) / 1000)) }
        List {
            SwiftUI.Section("Log time now") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 96))], spacing: 10) {
                    ForEach(quick, id: \.0) { m, label in
                        Button {
                            store.save(TimeEntry(projectId: project.id, minutes: m, note: note.isEmpty ? nil : note))
                            note = ""
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        } label: { Text("+ \(label)").frame(maxWidth: .infinity) }
                            .buttonStyle(.bordered)
                    }
                }
                TextField("Note (optional)", text: $note)
            }.glassRow()
            ForEach(groups.keys.sorted(by: >), id: \.self) { day in
                let list = (groups[day] ?? []).sorted { $0.loggedAt > $1.loggedAt }
                SwiftUI.Section {
                    ForEach(list) { e in
                        HStack {
                            Text(Date(timeIntervalSince1970: Double(e.loggedAt) / 1000), style: .time).font(.footnote.monospacedDigit()).foregroundStyle(.secondary).frame(width: 64, alignment: .leading)
                            Text(formatMinutes(e.minutes)).fontWeight(.semibold)
                            Text(e.note ?? "").foregroundStyle(.secondary).lineLimit(1)
                        }
                        .glassRow()
                        .swipeActions { Button(role: .destructive) { store.delete(e) } label: { Label("Delete", systemImage: "trash") } }
                    }
                } header: {
                    HStack { Text(day, style: .date); Spacer(); Text(formatMinutes(list.reduce(0) { $0 + $1.minutes })) }
                }
            }
        }
        .brandList()
    }
}

// MARK: - Commands (read-only: they run on your computer)

private struct CommandsSection: View {
    @Environment(AppStore.self) private var store
    let project: Project

    var body: some View {
        let cmds = store.commands(project.id)
        List(cmds) { c in
            VStack(alignment: .leading, spacing: 3) {
                Text(c.label).font(.headline)
                Text(c.command).font(.footnote.monospaced()).foregroundStyle(.secondary)
            }
            .glassRow()
            .contextMenu { Button("Copy command") { UIPasteboard.general.string = c.command } }
        }
        .brandList()
        .overlay { if cmds.isEmpty { ContentUnavailableView("No commands", systemImage: "terminal", description: Text("Commands are managed in BluePhoenix on your computer and can be copied here.")) } }
    }
}

// MARK: - Git (read-only, shared by the desktop app)

/// How a git state reads on the phone, matching the desktop dashboard.
struct GitState {
    let label: String
    let color: Color

    init?(_ raw: String) {
        switch raw {
        case "clean": label = "Up to date"; color = .green
        case "dirty": label = "Uncommitted changes"; color = .orange
        case "ahead": label = "To push"; color = .blue
        case "behind": label = "To pull"; color = .purple
        case "diverged": label = "Diverged"; color = .pink
        case "conflict": label = "Conflicts"; color = .red
        case "no-upstream": label = "Not published"; color = .secondary
        default: return nil
        }
    }

    /// A few words for the project list.
    func short(_ g: ProjectGit) -> String {
        switch label {
        case "Uncommitted changes": return "\(g.changed) changed"
        case "To push": return "\(g.ahead) to push"
        case "To pull": return "\(g.behind) to pull"
        case "Diverged": return "↑\(g.ahead) ↓\(g.behind)"
        default: return label
        }
    }
}

private struct GitSection: View {
    @Environment(AppStore.self) private var store
    let project: Project

    private func ago(_ ms: Int64) -> String {
        RelativeDateTimeFormatter().localizedString(for: Date(timeIntervalSince1970: Double(ms) / 1000), relativeTo: Date())
    }

    var body: some View {
        if let g = store.git(project.id) {
            List {
                SwiftUI.Section {
                    HStack {
                        Label(g.branch ?? "Detached", systemImage: "arrow.triangle.branch").font(.headline)
                        Spacer()
                        if let s = GitState(g.state) { Pill(text: s.label, color: s.color) }
                    }
                    .glassRow()
                    if g.ahead > 0 || g.behind > 0 {
                        HStack(spacing: 18) {
                            Label("\(g.ahead) to push", systemImage: "arrow.up")
                            Label("\(g.behind) to pull", systemImage: "arrow.down")
                        }
                        .font(.subheadline).foregroundStyle(.secondary)
                        .glassRow()
                    }
                    if g.changed > 0 {
                        Label("\(g.changed) uncommitted file\(g.changed == 1 ? "" : "s")", systemImage: "pencil.and.list.clipboard")
                            .font(.subheadline).foregroundStyle(.secondary)
                            .glassRow()
                    }
                } footer: {
                    Text("Shared by BluePhoenix on your computer, updated \(ago(g.updatedAt)).")
                }
                SwiftUI.Section("Recent commits") {
                    ForEach(g.commits, id: \.self) { c in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(c.subject).font(.subheadline).lineLimit(2)
                            Text("\(c.short) · \(c.author) · \(ago(c.ts))")
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        .glassRow()
                    }
                }
            }
            .brandList()
        } else {
            ContentUnavailableView("No git info yet", systemImage: "arrow.triangle.branch",
                                   description: Text("Open BluePhoenix on the computer that has this project's folder, with cloud sync on."))
        }
    }
}
