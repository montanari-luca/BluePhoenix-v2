import Foundation
import NIOCore
import NIOSSL
import PostgresNIO

struct SyncError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ m: String) { message = m }
}

struct ConnectionInfo {
    var host: String
    var port: Int
    var user: String
    var password: String
    var database: String
    var tls: Bool

    /// Parses `postgresql://user:password@host:5432/dbname?sslmode=require` (Neon, Supabase, plain Postgres).
    static func parse(_ raw: String) throws -> ConnectionInfo {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let c = URLComponents(string: text), let scheme = c.scheme, ["postgres", "postgresql"].contains(scheme) else {
            throw SyncError("The address must start with postgresql://")
        }
        guard let host = c.host, !host.isEmpty else { throw SyncError("The address has no host name") }
        guard let user = c.user, !user.isEmpty else { throw SyncError("The address has no user name") }
        var db = c.path
        if db.hasPrefix("/") { db.removeFirst() }
        let mode = c.queryItems?.first(where: { $0.name == "sslmode" })?.value ?? "require"
        return ConnectionInfo(
            host: host, port: c.port ?? 5432, user: user, password: c.password ?? "",
            database: db.isEmpty ? user : db, tls: mode != "disable"
        )
    }
}

enum PgSchema {
    static func statements() -> [String] {
        var out: [String] = []
        for t in allTables {
            let cols = t.cols.map { (n, ty) -> String in
                if n == "id" { return "id text PRIMARY KEY" }
                switch ty {
                case .text: return "\(n) text"
                case .int: return "\(n) bigint"
                case .bool: return "\(n) boolean"
                }
            }.joined(separator: ", ")
            out.append("CREATE TABLE IF NOT EXISTS \(t.pgName) (\(cols), deleted boolean NOT NULL DEFAULT false, server_ts bigint NOT NULL DEFAULT 0)")
            out.append("CREATE INDEX IF NOT EXISTS \(t.pgName)_ts ON \(t.pgName)(server_ts)")
            // Columns added in later versions (for example projects.archived_at) on an existing table.
            for (n, ty) in t.cols.dropFirst() {
                let sqlType: String
                switch ty {
                case .text: sqlType = "text"
                case .int: sqlType = "bigint"
                case .bool: sqlType = "boolean"
                }
                out.append("ALTER TABLE \(t.pgName) ADD COLUMN IF NOT EXISTS \(n) \(sqlType)")
            }
        }
        return out
    }

    static let allTables = [Project.table, TodoPage.table, Todo.table, CommandItem.table, TimeEntry.table, ProjectGit.table]
}

/// One short-lived connection per sync, talking straight to the user's Postgres.
struct RemoteDB {
    let info: ConnectionInfo

    func withClient<T>(_ body: (PostgresClient) async throws -> T) async throws -> T {
        let tls: PostgresClient.Configuration.TLS
        if info.tls {
            tls = .require(.makeClientConfiguration())
        } else {
            tls = .disable
        }
        var cfg = PostgresClient.Configuration(
            host: info.host, port: info.port, username: info.user, password: info.password, database: info.database, tls: tls
        )
        cfg.options.tlsServerName = info.host // Neon routes connections by SNI
        cfg.options.connectTimeout = .seconds(15)
        let client = PostgresClient(configuration: cfg)
        return try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { await client.run() }
            do {
                let result = try await body(client)
                group.cancelAll()
                return result
            } catch {
                group.cancelAll()
                throw error
            }
        }
    }

    static func describe(_ error: Error) -> String {
        if let e = error as? PSQLError {
            if let m = e.serverInfo?[.message] { return m }
            return "\(e.code)"
        }
        if let e = error as? SyncError { return e.message }
        return error.localizedDescription
    }

    func test() async throws -> String {
        try await withClient { client in
            let rows = try await client.query("SELECT version()")
            for try await (v) in rows.decode(String.self) { return v.split(separator: " ").prefix(2).joined(separator: " ") }
            return "connected"
        }
    }

    func ensureSchema(_ client: PostgresClient) async throws {
        for sql in PgSchema.statements() {
            _ = try await client.query(PostgresQuery(unsafeSQL: sql))
        }
    }

    private func bind(_ binds: inout PostgresBindings, _ v: PGValue) {
        switch v {
        case .s(let s): binds.append(s)
        case .i(let i): binds.append(i)
        case .b(let b): binds.append(b)
        }
    }

    func push<R: SyncRow>(_ rows: [R], client: PostgresClient) async throws {
        let t = R.table
        let n = t.cols.count
        let placeholders = (1...(n + 1)).map { "$\($0)" }.joined(separator: ",")
        let sets = (t.cols.dropFirst().map { "\($0.0)=EXCLUDED.\($0.0)" } + ["deleted=EXCLUDED.deleted", "server_ts=EXCLUDED.server_ts"]).joined(separator: ",")
        let sql = "INSERT INTO \(t.pgName)(\(t.colList),deleted,server_ts) VALUES(\(placeholders),(extract(epoch from clock_timestamp())*1000)::bigint) ON CONFLICT(id) DO UPDATE SET \(sets) WHERE \(t.pgName).updated_at IS NULL OR \(t.pgName).updated_at <= EXCLUDED.updated_at"
        for row in rows {
            var binds = PostgresBindings()
            for v in row.values { bind(&binds, v) }
            bind(&binds, .b(row.deleted))
            _ = try await client.query(PostgresQuery(unsafeSQL: sql, binds: binds))
        }
    }

    /// Rows whose server timestamp is at or after `cursor`.
    func pull<R: SyncRow>(_ type: R.Type, cursor: Int64, client: PostgresClient) async throws -> (rows: [R], maxTs: Int64) {
        let t = R.table
        let sql = "SELECT \(t.colList),deleted,server_ts FROM \(t.pgName) WHERE server_ts >= $1 ORDER BY server_ts"
        var binds = PostgresBindings()
        binds.append(cursor)
        let seq = try await client.query(PostgresQuery(unsafeSQL: sql, binds: binds))
        var out: [R] = []
        var maxTs = cursor
        for try await row in seq {
            let ra = row.makeRandomAccess()
            var values: [PGValue] = []
            for (i, col) in t.cols.enumerated() {
                switch col.1 {
                case .text: values.append(.s(try ra[i].decode(String?.self)))
                case .int: values.append(.i(try ra[i].decode(Int64?.self)))
                case .bool: values.append(.b(try ra[i].decode(Bool?.self) ?? false))
                }
            }
            let deleted = try ra[t.cols.count].decode(Bool.self)
            maxTs = max(maxTs, try ra[t.cols.count + 1].decode(Int64.self))
            out.append(R(values: values, deleted: deleted))
        }
        return (out, maxTs)
    }
}
