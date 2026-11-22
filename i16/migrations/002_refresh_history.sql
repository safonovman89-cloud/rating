CREATE TABLE rating_refresh_runs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rating_id text NOT NULL,
    checked_at timestamptz NOT NULL,
    trigger text NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'cli')),
    outcome text NOT NULL CHECK (outcome IN ('updated', 'unchanged', 'error')),
    duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
    error_message text
);

CREATE INDEX rating_refresh_runs_recent ON rating_refresh_runs (rating_id, checked_at DESC, id DESC);
