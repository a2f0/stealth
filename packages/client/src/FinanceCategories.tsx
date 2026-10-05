import {
  Banner,
  Button,
  Card,
  confirmDialog,
  EmptyState,
  Field,
  LoadingState,
  PageSection,
} from "@tearleads/ui/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  addDefaultExpenseCategories,
  createExpenseCategory,
  deleteExpenseCategory,
  type ExpenseCategory,
  renameExpenseCategory,
} from "./financeApi";
import { countLabel } from "./labels";

const maxNameLength = 60;

export function FinanceCategories({
  categories,
  onChanged,
}: {
  categories: ExpenseCategory[] | undefined;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const addDefaults = () =>
    run(async () => {
      const before = categories?.length ?? 0;
      const { categories: after } = await addDefaultExpenseCategories();
      const added = after.length - before;
      return added > 0
        ? `Added ${countLabel(added, "common category", "common categories")}.`
        : "All common categories are already here.";
    });

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const message = await action();
      await onChanged();
      setNotice(message);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      <AddCategoryForm
        busy={busy}
        onAdd={(name) =>
          run(async () => {
            await createExpenseCategory(name);
            return `Added “${name}”.`;
          })
        }
      />
      <PageSection
        actions={
          categories?.length ? (
            <div className="cluster">
              <span className="sectionCount">
                {countLabel(categories.length, "category", "categories")}
              </span>
              <Button
                disabled={busy}
                icon="layers"
                onClick={() => void addDefaults()}
                size="sm"
              >
                Add common categories
              </Button>
            </div>
          ) : undefined
        }
        description="Each transaction can have one expense category. Reports total spending by category."
        title="Expense categories"
      >
        <CategoryList
          busy={busy}
          categories={categories}
          onAddDefaults={addDefaults}
          onDelete={(category) =>
            run(async () => {
              await deleteExpenseCategory(category.id);
              return `Deleted “${category.name}”.`;
            })
          }
          onRename={(category, name) =>
            run(async () => {
              await renameExpenseCategory(category.id, name);
              return `Renamed to “${name}”.`;
            })
          }
        />
      </PageSection>
    </>
  );
}

function AddCategoryForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onAdd(name.trim())) setName("");
  }
  return (
    <Card
      description="Use names your bookkeeper will recognize, such as Meals or Software."
      footer={
        <Button
          busy={busy}
          disabled={!name.trim()}
          icon="add"
          type="submit"
          variant="primary"
        >
          Add category
        </Button>
      }
      onSubmit={(event) => void submit(event)}
      title="Add a category"
    >
      <Field label="Category name">
        <input
          className="input"
          maxLength={maxNameLength}
          onChange={(event) => setName(event.target.value)}
          placeholder="Office supplies"
          required
          value={name}
        />
      </Field>
    </Card>
  );
}

function CategoryList({
  busy,
  categories,
  onAddDefaults,
  onDelete,
  onRename,
}: {
  busy: boolean;
  categories: ExpenseCategory[] | undefined;
  onAddDefaults: () => Promise<boolean>;
  onDelete: (category: ExpenseCategory) => Promise<boolean>;
  onRename: (category: ExpenseCategory, name: string) => Promise<boolean>;
}) {
  if (!categories) return <LoadingState label="Loading categories…" />;
  if (!categories.length) {
    return (
      <EmptyState
        actions={
          <Button
            busy={busy}
            icon="layers"
            onClick={() => void onAddDefaults()}
            variant="primary"
          >
            Add common categories
          </Button>
        }
        icon="layers"
        title="No expense categories yet"
      >
        Start with a common set for small businesses, or add your own above.
      </EmptyState>
    );
  }
  return (
    <Card flush>
      <ul className="rowList">
        {categories.map((category) => (
          <CategoryRow
            busy={busy}
            category={category}
            key={category.id}
            onDelete={onDelete}
            onRename={onRename}
          />
        ))}
      </ul>
    </Card>
  );
}

function CategoryRow({
  busy,
  category,
  onDelete,
  onRename,
}: {
  busy: boolean;
  category: ExpenseCategory;
  onDelete: (category: ExpenseCategory) => Promise<boolean>;
  onRename: (category: ExpenseCategory, name: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <RenameCategoryRow
        busy={busy}
        category={category}
        onCancel={() => setEditing(false)}
        onSave={async (name) => {
          if (await onRename(category, name)) setEditing(false);
        }}
      />
    );
  }
  async function remove() {
    if (await confirmCategoryDeletion(category)) void onDelete(category);
  }
  return (
    <li className="row">
      <div className="rowMain">
        <span className="rowTitle">{category.name}</span>
        <span className="rowMeta">
          {countLabel(category.transactionCount, "transaction")}
        </span>
      </div>
      <div className="rowActions">
        <Button
          disabled={busy}
          icon="edit"
          onClick={() => setEditing(true)}
          size="sm"
          variant="ghost"
        >
          Rename
        </Button>
        <Button
          disabled={busy}
          icon="trash"
          onClick={() => void remove()}
          size="sm"
          variant="danger"
        >
          Delete
        </Button>
      </div>
    </li>
  );
}

function RenameCategoryRow({
  busy,
  category,
  onCancel,
  onSave,
}: {
  busy: boolean;
  category: ExpenseCategory;
  onCancel: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(category.name);
  const input = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  // The Rename button that had focus is gone; move focus to the field.
  useEffect(() => input.current?.select(), []);
  return (
    <li className="row">
      <form
        aria-label={`Rename ${category.name}`}
        className="financeCategoryRename"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(trimmed);
        }}
      >
        <Field className="financeCategoryRenameField" label="Category name">
          <input
            className="input inputSm"
            maxLength={maxNameLength}
            onChange={(event) => setName(event.target.value)}
            ref={input}
            required
            value={name}
          />
        </Field>
        <div className="rowActions">
          <Button onClick={onCancel} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!trimmed || trimmed === category.name}
            size="sm"
            type="submit"
            variant="primary"
          >
            Save
          </Button>
        </div>
      </form>
    </li>
  );
}

function confirmCategoryDeletion(category: ExpenseCategory) {
  return confirmDialog({
    confirmLabel: "Delete category",
    message: category.transactionCount
      ? `${countLabel(category.transactionCount, "transaction")} will become uncategorized.`
      : undefined,
    title: `Delete “${category.name}”?`,
    tone: "danger",
  });
}
