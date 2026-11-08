import Foundation
import Observation

@MainActor
@Observable
final class AppStore {
    var cache = Cache()
    var syncing = false
    var lastError: String?
    var connected = false

    @ObservationIgnored private var pendingSync = false
    @ObservationIgnored private let fileURL: URL

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("bluephoenix-cache.json")
        if let data = try? Data(contentsOf: fileURL), let c = try? JSONDecoder().decode(Cache.self, from: data) {
            cache = c
        }
        connected = Keychain.get() != nil
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(cache) { try? data.write(to: fileURL, options: .atomic) }
    }

    // MARK: Reading

    var projects: [Project] {
        cache.projects.filter { !$0.deleted && $0.archivedAt == nil }.sorted {
            if $0.favorite != $1.favorite { return $0.favorite }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }
    var archivedProjects: [Project] {
        cache.projects.filter { !$0.deleted && $0.archivedAt != nil }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
    func project(_ id: String) -> Project? { cache.projects.first { $0.id == id && !$0.deleted } }
    /// The git summary your computer shares for this project, if any.
    func git(_ pid: String) -> ProjectGit? { cache.gitRows.first { $0.projectId == pid && !$0.deleted } }
    func todos(_ pid: String) -> [Todo] {
        cache.todos.filter { $0.projectId == pid && !$0.deleted }.sorted { ($0.sort, $0.createdAt) < ($1.sort, $1.createdAt) }
    }
    func pages(_ pid: String) -> [TodoPage] {
        cache.pages.filter { $0.projectId == pid && !$0.deleted }.sorted { $0.sort < $1.sort }
    }
    func commands(_ pid: String) -> [CommandItem] {
        cache.commands.filter { $0.projectId == pid && !$0.deleted }.sorted { $0.sort < $1.sort }
    }
    func time(_ pid: String) -> [TimeEntry] {
        cache.time.filter { $0.projectId == pid && !$0.deleted }.sorted { $0.loggedAt > $1.loggedAt }
    }
    func minutes(_ pid: String) -> Int64 { time(pid).reduce(0) { $0 + $1.minutes } }
    func openTodos(_ pid: String) -> Int { todos(pid).filter { !$0.isDone }.count }

    // MARK: Writing (local first, then synced in the background)

    private func upsert<R: SyncRow>(_ row: R, _ kp: WritableKeyPath<Cache, [R]>) {
        var r = row
        r.updatedAt = max(nowMs(), row.updatedAt + 1)
        r.dirty = true
        if let i = cache[keyPath: kp].firstIndex(where: { $0.id == r.id }) {
            cache[keyPath: kp][i] = r
        } else {
            cache[keyPath: kp].append(r)
        }
        persist()
        requestSync()
    }

    func save(_ p: Project) { upsert(p, \.projects) }
    func setArchived(_ p: Project, _ archived: Bool) {
        var p = p
        p.archivedAt = archived ? nowMs() : nil
        upsert(p, \.projects)
    }
    func save(_ t: Todo) {
        var t = t
        if t.status == "done", t.completedAt == nil { t.completedAt = nowMs() }
        if t.status != "done" { t.completedAt = nil }
        upsert(t, \.todos)
    }
    func save(_ p: TodoPage) { upsert(p, \.pages) }
    func save(_ e: TimeEntry) { upsert(e, \.time) }

    func delete(_ t: Todo) { var t = t; t.deleted = true; upsert(t, \.todos) }
    func delete(_ p: TodoPage) {
        var p = p; p.deleted = true; upsert(p, \.pages)
        for var t in todos(p.projectId) where t.pageId == p.id { t.pageId = nil; upsert(t, \.todos) }
    }
    func delete(_ e: TimeEntry) { var e = e; e.deleted = true; upsert(e, \.time) }
    func delete(_ p: Project) {
        var p = p; p.deleted = true; upsert(p, \.projects)
        for var t in todos(p.id) { t.deleted = true; upsert(t, \.todos) }
        for var g in pages(p.id) { g.deleted = true; upsert(g, \.pages) }
        for var c in commands(p.id) { c.deleted = true; upsert(c, \.commands) }
        for var e in time(p.id) { e.deleted = true; upsert(e, \.time) }
    }

    func addTodo(_ title: String, to pid: String, page: String? = nil) {
        let next = (todos(pid).map(\.sort).max() ?? 0) + 1
        save(Todo(projectId: pid, title: title, pageId: page, sort: next))
    }

    // MARK: Sync

    func requestSync() {
        guard connected else { return }
        if syncing { pendingSync = true; return }
        Task { await sync() }
    }

    func connect(url: String) async throws {
        let info = try ConnectionInfo.parse(url)
        _ = try await RemoteDB(info: info).test()
        Keychain.set(url.trimmingCharacters(in: .whitespacesAndNewlines))
        connected = true
        // A (possibly different) database: start over and upload everything.
        cache.cursors = [:]
        for i in cache.projects.indices { cache.projects[i].dirty = true }
        for i in cache.pages.indices { cache.pages[i].dirty = true }
        for i in cache.todos.indices { cache.todos[i].dirty = true }
        for i in cache.commands.indices { cache.commands[i].dirty = true }
        for i in cache.time.indices { cache.time[i].dirty = true }
        persist()
        await sync()
        if let e = lastError { throw SyncError(e) }
    }

    func disconnect() {
        Keychain.delete()
        connected = false
        cache.cursors = [:]
        cache.lastSync = nil
        lastError = nil
        persist()
    }

    func eraseLocalData() {
        disconnect()
        cache = Cache()
        persist()
    }

    func sync() async {
        guard !syncing, let url = Keychain.get() else { return }
        syncing = true
        lastError = nil
        defer {
            syncing = false
            if pendingSync { pendingSync = false; Task { await sync() } }
        }
        do {
            let db = RemoteDB(info: try ConnectionInfo.parse(url))
            let dProjects = cache.projects.filter(\.dirty)
            let dPages = cache.pages.filter(\.dirty)
            let dTodos = cache.todos.filter(\.dirty)
            let dCommands = cache.commands.filter(\.dirty)
            let dTime = cache.time.filter(\.dirty)
            let cur = cache.cursors

            let pulled = try await db.withClient { client -> PulledData in
                try await db.ensureSchema(client)
                try await db.push(dProjects, client: client)
                try await db.push(dPages, client: client)
                try await db.push(dTodos, client: client)
                try await db.push(dCommands, client: client)
                try await db.push(dTime, client: client)
                return PulledData(
                    projects: try await db.pull(Project.self, cursor: cur["projects"] ?? 0, client: client),
                    pages: try await db.pull(TodoPage.self, cursor: cur["todo_pages"] ?? 0, client: client),
                    todos: try await db.pull(Todo.self, cursor: cur["todos"] ?? 0, client: client),
                    commands: try await db.pull(CommandItem.self, cursor: cur["commands"] ?? 0, client: client),
                    time: try await db.pull(TimeEntry.self, cursor: cur["time_entries"] ?? 0, client: client),
                    git: try await db.pull(ProjectGit.self, cursor: cur["project_git"] ?? 0, client: client)
                )
            }

            markClean(dProjects, \.projects); markClean(dPages, \.pages); markClean(dTodos, \.todos)
            markClean(dCommands, \.commands); markClean(dTime, \.time)
            merge(pulled.projects.rows, \.projects); merge(pulled.pages.rows, \.pages); merge(pulled.todos.rows, \.todos)
            merge(pulled.commands.rows, \.commands); merge(pulled.time.rows, \.time); merge(pulled.git.rows, \.gitRows)
            cache.cursors["projects"] = pulled.projects.maxTs
            cache.cursors["todo_pages"] = pulled.pages.maxTs
            cache.cursors["todos"] = pulled.todos.maxTs
            cache.cursors["commands"] = pulled.commands.maxTs
            cache.cursors["time_entries"] = pulled.time.maxTs
            cache.cursors["project_git"] = pulled.git.maxTs
            cache.lastSync = nowMs()
            persist()
        } catch {
            lastError = RemoteDB.describe(error)
        }
    }

    private struct PulledData {
        var projects: (rows: [Project], maxTs: Int64)
        var pages: (rows: [TodoPage], maxTs: Int64)
        var todos: (rows: [Todo], maxTs: Int64)
        var commands: (rows: [CommandItem], maxTs: Int64)
        var time: (rows: [TimeEntry], maxTs: Int64)
        var git: (rows: [ProjectGit], maxTs: Int64)
    }

    /// Rows edited again while uploading stay dirty.
    private func markClean<R: SyncRow>(_ pushed: [R], _ kp: WritableKeyPath<Cache, [R]>) {
        for p in pushed {
            if let i = cache[keyPath: kp].firstIndex(where: { $0.id == p.id && $0.updatedAt == p.updatedAt }) {
                cache[keyPath: kp][i].dirty = false
            }
        }
    }

    /// Last write wins on `updatedAt`.
    private func merge<R: SyncRow>(_ remote: [R], _ kp: WritableKeyPath<Cache, [R]>) {
        var index: [String: Int] = [:]
        for (i, r) in cache[keyPath: kp].enumerated() { index[r.id] = i }
        for var r in remote {
            r.dirty = false
            if let i = index[r.id] {
                if cache[keyPath: kp][i].updatedAt < r.updatedAt { cache[keyPath: kp][i] = r }
            } else {
                cache[keyPath: kp].append(r)
                index[r.id] = cache[keyPath: kp].count - 1
            }
        }
    }
}
