from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from .dataset import Dataset, Observation, Snapshot, Source


class StoreError(RuntimeError):
    """PostgreSQL не может выполнить запрос."""


class RatingMissing(StoreError):
    """Настроенный рейтинг ещё не загружен."""


class Postgres:
    def __init__(self, dsn: str):
        self.dsn = dsn

    def _connect(self):
        return psycopg.connect(self.dsn, row_factory=dict_row, connect_timeout=3)

    def migrate(self):
        try:
            with self._connect() as conn:
                conn.execute("SELECT pg_advisory_xact_lock(20829, 16)")
                conn.execute("CREATE TABLE IF NOT EXISTS i16_schema_migrations (version text PRIMARY KEY)")
                applied = {row["version"] for row in conn.execute("SELECT version FROM i16_schema_migrations")}
                for path in sorted(Path(__file__).with_name("migrations").glob("*.sql")):
                    if path.name not in applied:
                        conn.execute(path.read_text(encoding="utf-8"), prepare=False)
                        conn.execute("INSERT INTO i16_schema_migrations (version) VALUES (%s)", (path.name,))
        except psycopg.Error as error:
            raise StoreError(_database_message(error)) from error

    def save(self, dataset: Dataset):
        try:
            with self._connect() as conn:
                identifier = dataset.rating_id
                conn.execute("""
                    INSERT INTO ratings (rating_id, title, data_kind) VALUES (%s, %s, %s)
                    ON CONFLICT (rating_id) DO UPDATE SET title = EXCLUDED.title, data_kind = EXCLUDED.data_kind
                    """, (identifier, dataset.title, dataset.data_kind))
                with conn.cursor() as cursor:
                    cursor.executemany("""
                        INSERT INTO subjects (rating_id, subject_id, name) VALUES (%s, %s, %s)
                        ON CONFLICT (rating_id, subject_id) DO UPDATE SET name = EXCLUDED.name
                        """, [(identifier, subject, name) for subject, name in sorted(dataset.subjects.items())])
                    for snapshot in dataset.snapshots.values():
                        self._save_snapshot(cursor, identifier, snapshot)
        except psycopg.Error as error:
            raise StoreError(_database_message(error)) from error

    def _save_snapshot(self, cursor, identifier, snapshot):
        source = snapshot.source
        cursor.execute("""
            INSERT INTO rating_snapshots (
                rating_id, period, methodology_version, score_min, score_max, cohort_id, population_size,
                source_title, source_reference, published_on, data_reference
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (rating_id, period) DO UPDATE SET
                methodology_version = EXCLUDED.methodology_version, score_min = EXCLUDED.score_min,
                score_max = EXCLUDED.score_max, cohort_id = EXCLUDED.cohort_id,
                population_size = EXCLUDED.population_size, source_title = EXCLUDED.source_title,
                source_reference = EXCLUDED.source_reference, published_on = EXCLUDED.published_on,
                data_reference = EXCLUDED.data_reference
            """, (identifier, snapshot.period, snapshot.methodology_version, snapshot.score_min, snapshot.score_max,
                  snapshot.cohort_id, snapshot.population_size, source.title, source.reference,
                  source.published_on, source.data_reference))
        cursor.execute("DELETE FROM rating_results WHERE rating_id = %s AND period = %s", (identifier, snapshot.period))
        cursor.executemany("""
            INSERT INTO rating_results (rating_id, period, subject_id, rank, score) VALUES (%s, %s, %s, %s, %s)
            """, [(identifier, snapshot.period, subject, row.rank, row.score) for subject, row in snapshot.rows.items()])

    def load(self, identifier: str) -> Dataset:
        try:
            with self._connect() as conn:
                conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                rating = conn.execute("SELECT title, data_kind FROM ratings WHERE rating_id = %s", (identifier,)).fetchone()
                if rating is None:
                    raise RatingMissing("Настроенный рейтинг отсутствует. Загрузите JSON-набор.")
                subjects = {row["subject_id"]: row["name"] for row in conn.execute(
                    "SELECT subject_id, name FROM subjects WHERE rating_id = %s ORDER BY subject_id", (identifier,)
                )}
                snapshots = {}
                for row in conn.execute("SELECT * FROM rating_snapshots WHERE rating_id = %s ORDER BY period DESC", (identifier,)):
                    source = Source(row["source_title"], row["source_reference"], row["published_on"], row["data_reference"])
                    period = row["period"]
                    snapshots[period] = Snapshot(period, row["methodology_version"], row["score_min"], row["score_max"],
                                                 row["cohort_id"], row["population_size"], source, {})
                for row in conn.execute("SELECT period, subject_id, rank, score FROM rating_results WHERE rating_id = %s", (identifier,)):
                    snapshots[row["period"]].rows[row["subject_id"]] = Observation(row["rank"], row["score"])
                return Dataset(identifier, rating["title"], rating["data_kind"], subjects, snapshots)
        except psycopg.Error as error:
            raise StoreError(_database_message(error)) from error

    def record_refresh(self, identifier, checked_at, trigger, outcome, duration_ms, error_message):
        try:
            with self._connect() as conn:
                conn.execute("""
                    INSERT INTO rating_refresh_runs (rating_id, checked_at, trigger, outcome, duration_ms, error_message)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """, (identifier, checked_at, trigger, outcome, duration_ms, error_message))
        except psycopg.Error as error:
            raise StoreError(_database_message(error)) from error

    def admin_analytics(self, identifier):
        try:
            with self._connect() as conn:
                conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                subject_count = conn.execute(
                    "SELECT count(*) AS total FROM subjects WHERE rating_id = %s", (identifier,)
                ).fetchone()["total"]
                snapshots = conn.execute("""
                    SELECT s.period, s.published_on, s.population_size,
                           count(r.subject_id) AS loaded,
                           count(*) FILTER (WHERE r.rank IS NOT NULL AND r.score IS NOT NULL) AS complete,
                           count(r.subject_id) FILTER (WHERE r.rank IS NULL) AS missing_rank,
                           count(r.subject_id) FILTER (WHERE r.score IS NULL) AS missing_score
                    FROM rating_snapshots s
                    LEFT JOIN rating_results r ON (s.rating_id, s.period) = (r.rating_id, r.period)
                    WHERE s.rating_id = %s
                    GROUP BY s.period, s.published_on, s.population_size
                    ORDER BY s.period DESC
                    """, (identifier,)).fetchall()
                history_summary = conn.execute("""
                    SELECT count(*) AS total,
                           count(*) FILTER (WHERE outcome = 'updated') AS updated,
                           count(*) FILTER (WHERE outcome = 'unchanged') AS unchanged,
                           count(*) FILTER (WHERE outcome = 'error') AS errors
                    FROM rating_refresh_runs
                    WHERE rating_id = %s AND checked_at >= CURRENT_TIMESTAMP - interval '720 hours'
                    """, (identifier,)).fetchone()
                recent_runs = conn.execute("""
                    SELECT checked_at, trigger, outcome, duration_ms, error_message
                    FROM rating_refresh_runs WHERE rating_id = %s
                    ORDER BY checked_at DESC, id DESC LIMIT 10
                    """, (identifier,)).fetchall()
        except psycopg.Error as error:
            raise StoreError(_database_message(error)) from error

        for row in snapshots:
            row["published_on"] = row["published_on"].isoformat()
        for row in recent_runs:
            row["checked_at"] = row["checked_at"].isoformat()
        return {
            "subject_count": subject_count, "snapshot_count": len(snapshots),
            "observation_count": sum(row["loaded"] for row in snapshots), "snapshots": snapshots,
            "refresh_summary": history_summary, "recent_runs": recent_runs,
        }


def _database_message(error):
    if error.sqlstate == "42P01":
        return "Схема PostgreSQL отсутствует. Выполните команду migrate."
    if error.sqlstate:
        return f"Ошибка PostgreSQL (SQLSTATE {error.sqlstate})."
    return "PostgreSQL недоступен. Проверьте работу базы и параметры подключения."
