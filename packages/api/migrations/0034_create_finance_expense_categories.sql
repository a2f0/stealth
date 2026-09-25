CREATE TABLE finance_expense_categories (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX finance_expense_categories_name_idx
ON finance_expense_categories (organization_id, name COLLATE NOCASE);

-- A transaction has at most one expense category: a single nullable
-- reference on its annotation. Deleting a category leaves it uncategorized.
ALTER TABLE finance_transaction_annotations
ADD COLUMN expense_category_id TEXT
  REFERENCES finance_expense_categories (id) ON DELETE SET NULL;

CREATE INDEX finance_transaction_annotations_category_idx
ON finance_transaction_annotations (organization_id, expense_category_id);

-- Free-text category overrides become managed categories, one per distinct
-- name in each organization, and their transactions are assigned to them.
INSERT INTO finance_expense_categories
  (id, organization_id, name, created_at, updated_at)
SELECT lower(hex(randomblob(16))), organization_id, MIN(trim(category_override)),
       MIN(created_at), MAX(updated_at)
FROM finance_transaction_annotations
WHERE category_override IS NOT NULL AND trim(category_override) <> ''
GROUP BY organization_id, lower(trim(category_override));

UPDATE finance_transaction_annotations
SET expense_category_id = (
  SELECT category.id
  FROM finance_expense_categories AS category
  WHERE category.organization_id = finance_transaction_annotations.organization_id
    AND category.name = trim(finance_transaction_annotations.category_override)
      COLLATE NOCASE
)
WHERE category_override IS NOT NULL AND trim(category_override) <> '';
