CREATE TABLE workspace_users (
    email text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_email_links (
    email text PRIMARY KEY,
    token_hash text UNIQUE,
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);

CREATE INDEX workspace_email_links_issued_at ON workspace_email_links (issued_at);

CREATE TABLE workspace_sessions (
    token_hash text PRIMARY KEY,
    email text NOT NULL REFERENCES workspace_users (email),
    expires_at timestamptz NOT NULL
);

CREATE INDEX workspace_sessions_expires_at ON workspace_sessions (expires_at);
