import Foundation

func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

// MARK: - Column plumbing (mirrors the desktop app's sync tables, see src-tauri/src/sync.rs)

enum ColType { case text, int, bool }

struct TableDef {
    let name: String
    let cols: [(String, ColType)]
    var pgName: String { "bp_\(name)" }
    var colList: String { cols.map(\.0).joined(separator: ",") }
}

enum PGValue {
    case s(String?)
    case i(Int64?)
    case b(Bool)

    var string: String? { if case .s(let v) = self { return v }; return nil }
    var int: Int64? { if case .i(let v) = self { return v }; return nil }
    var bool: Bool { if case .b(let v) = self { return v }; return false }
}

protocol SyncRow: Codable, Identifiable, Equatable {
    static var table: TableDef { get }
    var id: String { get }
    var updatedAt: Int64 { get set }
    var deleted: Bool { get set }
    var dirty: Bool { get set }
    var values: [PGValue] { get }
    init(values: [PGValue], deleted: Bool)
}

// MARK: - Rows

struct Project: SyncRow {
    static let table = TableDef(name: "projects", cols: [
        ("id", .text), ("name", .text), ("description", .text), ("kind", .text), ("favorite", .bool),
        ("github_url", .text), ("website_url", .text), ("created_at", .int), ("updated_at", .int),
        ("archived_at", .int),
    ])
    var id: String
    var name: String
    var description: String?
    var kind: String
    var favorite: Bool
    var githubUrl: String?
    var websiteUrl: String?
    var createdAt: Int64
    var updatedAt: Int64
    /// Set when archived on any device: hidden from the main list.
    var archivedAt: Int64?
    var deleted = false
    var dirty = false

    var values: [PGValue] {
        [.s(id), .s(name), .s(description), .s(kind), .b(favorite), .s(githubUrl), .s(websiteUrl), .i(createdAt), .i(updatedAt), .i(archivedAt)]
    }
    init(values v: [PGValue], deleted: Bool) {
        id = v[0].string ?? ""
        name = v[1].string ?? ""
        description = v[2].string
        kind = v[3].string ?? "Other"
        favorite = v[4].bool
        githubUrl = v[5].string
        websiteUrl = v[6].string
        createdAt = v[7].int ?? 0
        updatedAt = v[8].int ?? 0
        archivedAt = v.count > 9 ? v[9].int : nil
        self.deleted = deleted
    }
    init(name: String, kind: String = "Other") {
        id = UUID().uuidString.lowercased()
        self.name = name
        self.kind = kind
        favorite = false
        createdAt = nowMs()
        updatedAt = createdAt
        dirty = true
    }
}

struct TodoPage: SyncRow {
    static let table = TableDef(name: "todo_pages", cols: [
        ("id", .text), ("project_id", .text), ("title", .text), ("markdown", .text), ("sort", .int), ("updated_at", .int),
    ])
    var id: String
    var projectId: String
    var title: String
    var markdown: String
    var sort: Int64
    var updatedAt: Int64
    var deleted = false
    var dirty = false

    var values: [PGValue] { [.s(id), .s(projectId), .s(title), .s(markdown), .i(sort), .i(updatedAt)] }
    init(values v: [PGValue], deleted: Bool) {
        id = v[0].string ?? ""
        projectId = v[1].string ?? ""
        title = v[2].string ?? ""
        markdown = v[3].string ?? ""
        sort = v[4].int ?? 0
        updatedAt = v[5].int ?? 0
        self.deleted = deleted
    }
    init(projectId: String, title: String, sort: Int64) {
        id = UUID().uuidString.lowercased()
        self.projectId = projectId
        self.title = title
        markdown = ""
        self.sort = sort
        updatedAt = nowMs()
        dirty = true
    }
}

struct Todo: SyncRow {
    static let table = TableDef(name: "todos", cols: [
        ("id", .text), ("project_id", .text), ("page_id", .text), ("title", .text), ("notes", .text), ("status", .text),
        ("priority", .int), ("due", .int), ("ai_prompt", .text), ("sort", .int), ("created_at", .int),
        ("completed_at", .int), ("updated_at", .int),
    ])
    var id: String
    var projectId: String
    var pageId: String?
    var title: String
    var notes: String
    var status: String // todo | doing | done
    var priority: Int64
    var due: Int64?
    var aiPrompt: String?
    var sort: Int64
    var createdAt: Int64
    var completedAt: Int64?
    var updatedAt: Int64
    var deleted = false
    var dirty = false

    var isDone: Bool { status == "done" }

    var values: [PGValue] {
        [.s(id), .s(projectId), .s(pageId), .s(title), .s(notes), .s(status), .i(priority), .i(due), .s(aiPrompt),
         .i(sort), .i(createdAt), .i(completedAt), .i(updatedAt)]
    }
    init(values v: [PGValue], deleted: Bool) {
        id = v[0].string ?? ""
        projectId = v[1].string ?? ""
        pageId = v[2].string
        title = v[3].string ?? ""
        notes = v[4].string ?? ""
        status = v[5].string ?? "todo"
        priority = v[6].int ?? 0
        due = v[7].int
        aiPrompt = v[8].string
        sort = v[9].int ?? 0
        createdAt = v[10].int ?? 0
        completedAt = v[11].int
        updatedAt = v[12].int ?? 0
        self.deleted = deleted
    }
    init(projectId: String, title: String, pageId: String? = nil, sort: Int64) {
        id = UUID().uuidString.lowercased()
        self.projectId = projectId
        self.pageId = pageId
        self.title = title
        notes = ""
        status = "todo"
        priority = 0
        self.sort = sort
        createdAt = nowMs()
        updatedAt = createdAt
        dirty = true
    }
}

struct CommandItem: SyncRow {
    static let table = TableDef(name: "commands", cols: [
        ("id", .text), ("project_id", .text), ("label", .text), ("command", .text), ("cwd", .text), ("source", .text),
        ("sort", .int), ("updated_at", .int),
    ])
    var id: String
    var projectId: String
    var label: String
    var command: String
    var cwd: String?
    var source: String
    var sort: Int64
    var updatedAt: Int64
    var deleted = false
    var dirty = false

    var values: [PGValue] { [.s(id), .s(projectId), .s(label), .s(command), .s(cwd), .s(source), .i(sort), .i(updatedAt)] }
    init(values v: [PGValue], deleted: Bool) {
        id = v[0].string ?? ""
        projectId = v[1].string ?? ""
        label = v[2].string ?? ""
        command = v[3].string ?? ""
        cwd = v[4].string
        source = v[5].string ?? "manual"
        sort = v[6].int ?? 0
        updatedAt = v[7].int ?? 0
        self.deleted = deleted
    }
}

struct TimeEntry: SyncRow {
    static let table = TableDef(name: "time_entries", cols: [
        ("id", .text), ("project_id", .text), ("todo_id", .text), ("minutes", .int), ("logged_at", .int),
        ("note", .text), ("updated_at", .int),
    ])
    var id: String
    var projectId: String
    var todoId: String?
    var minutes: Int64
    var loggedAt: Int64
    var note: String?
    var updatedAt: Int64
    var deleted = false
    var dirty = false

    var values: [PGValue] { [.s(id), .s(projectId), .s(todoId), .i(minutes), .i(loggedAt), .s(note), .i(updatedAt)] }
    init(values v: [PGValue], deleted: Bool) {
        id = v[0].string ?? ""
        projectId = v[1].string ?? ""
        todoId = v[2].string
        minutes = v[3].int ?? 0
        loggedAt = v[4].int ?? 0
        note = v[5].string
        updatedAt = v[6].int ?? 0
        self.deleted = deleted
    }
    init(projectId: String, minutes: Int64, note: String?, todoId: String? = nil, at: Int64 = nowMs()) {
        id = UUID().uuidString.lowercased()
        self.projectId = projectId
        self.todoId = todoId
        self.minutes = minutes
        loggedAt = at
        self.note = note
        updatedAt = nowMs()
        dirty = true
    }
}

/// A git summary the desktop app shares for each project. Read-only here: the phone never writes it.
struct ProjectGit: SyncRow {
    static let table = TableDef(name: "project_git", cols: [
        ("id", .text), ("project_id", .text), ("branch", .text), ("state", .text), ("ahead", .int), ("behind", .int),
        ("changed", .int), ("last_commit_ts", .int), ("last_commit_subject", .text), ("commits", .text), ("updated_at", .int),
    ])
    struct Commit: Codable, Hashable {
        var short: String
        var subject: String
        var author: String
        var ts: Int64
    }

    var id: String
    var projectId: String
    var branch: String?
    /// no-repo | conflict | dirty | diverged | ahead | behind | no-upstream | clean
    var state: String
    var ahead: Int64
    var behind: Int64
    var changed: Int64
    var lastCommitTs: Int64?
    var lastCommitSubject: String?
    var commitsJSON: String
    var updatedAt: Int64
    var deleted = false
    var dirty = false

    var commits: [Commit] {
        (try? JSONDecoder().decode([Commit].self, from: Data(commitsJSON.utf8))) ?? []
    }

    var values: [PGValue] {
        [.s(id), .s(projectId), .s(branch), .s(state), .i(ahead), .i(behind), .i(changed), .i(lastCommitTs), .s(lastCommitSubject),
         .s(commitsJSON), .i(updatedAt)]
    }
    init(values v: [PGValue], deleted: Bool) {
        id = v[0].string ?? ""
        projectId = v[1].string ?? ""
        branch = v[2].string
        state = v[3].string ?? ""
        ahead = v[4].int ?? 0
        behind = v[5].int ?? 0
        changed = v[6].int ?? 0
        lastCommitTs = v[7].int
        lastCommitSubject = v[8].string
        commitsJSON = v[9].string ?? "[]"
        updatedAt = v[10].int ?? 0
        self.deleted = deleted
    }
}

struct Cache: Codable {
    var projects: [Project] = []
    var pages: [TodoPage] = []
    var todos: [Todo] = []
    var commands: [CommandItem] = []
    var time: [TimeEntry] = []
    /// Optional so caches saved by older versions still decode.
    var git: [ProjectGit]?
    var cursors: [String: Int64] = [:]
    var lastSync: Int64?

    var gitRows: [ProjectGit] {
        get { git ?? [] }
        set { git = newValue }
    }
}

// MARK: - Formatting

func formatMinutes(_ total: Int64) -> String {
    if total <= 0 { return "0m" }
    let h = total / 60, m = total % 60
    if h == 0 { return "\(m)m" }
    return m == 0 ? "\(h)h" : "\(h)h \(m)m"
}
