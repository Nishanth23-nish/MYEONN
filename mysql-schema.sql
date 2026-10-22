-- Myeonn MySQL backend schema
-- The Node API stores each business collection as a JSON document so existing
-- products, users, orders, inventory and session logic migrate without data loss.

CREATE TABLE IF NOT EXISTS myeonn_documents (
  document_key VARCHAR(128) PRIMARY KEY,
  payload JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
