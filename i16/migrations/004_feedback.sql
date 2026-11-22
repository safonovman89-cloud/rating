CREATE TABLE feedback_messages (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    received_at timestamptz NOT NULL DEFAULT now(),
    email text,
    message text NOT NULL CHECK (char_length(message) BETWEEN 3 AND 3000)
);
