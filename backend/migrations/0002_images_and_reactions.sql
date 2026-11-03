-- Recreate messages table to allow optional text when image_url is present
CREATE TABLE IF NOT EXISTS messages_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '' CHECK (length(content) <= 4000),
    image_url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO messages_new (id, user_id, content, created_at)
SELECT id, user_id, content, created_at FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    emoji TEXT NOT NULL CHECK (length(trim(emoji)) > 0 AND length(emoji) <= 32),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_msg ON message_reactions(message_id);

