CREATE TABLE ratings (
    rating_id text PRIMARY KEY,
    title text NOT NULL,
    data_kind text NOT NULL CHECK (data_kind IN ('demo', 'production'))
);

CREATE TABLE subjects (
    rating_id text NOT NULL REFERENCES ratings (rating_id),
    subject_id text NOT NULL,
    name text NOT NULL,
    PRIMARY KEY (rating_id, subject_id)
);

CREATE TABLE rating_snapshots (
    rating_id text NOT NULL REFERENCES ratings (rating_id),
    period text NOT NULL CHECK (period ~ '^[0-9]{4}$' AND period <> '0000'),
    methodology_version text NOT NULL,
    score_min numeric NOT NULL,
    score_max numeric NOT NULL,
    cohort_id text,
    population_size bigint NOT NULL CHECK (population_size > 0),
    source_title text NOT NULL,
    source_reference text NOT NULL,
    published_on date NOT NULL,
    data_reference text,
    CHECK (score_min < score_max),
    PRIMARY KEY (rating_id, period)
);

CREATE TABLE rating_results (
    rating_id text NOT NULL,
    period text NOT NULL,
    subject_id text NOT NULL,
    rank bigint CHECK (rank > 0),
    score numeric,
    PRIMARY KEY (rating_id, period, subject_id),
    FOREIGN KEY (rating_id, period) REFERENCES rating_snapshots (rating_id, period),
    FOREIGN KEY (rating_id, subject_id) REFERENCES subjects (rating_id, subject_id)
);
