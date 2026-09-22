# @tearleads/ui

The design system shared by the marketing site (`apps/website`) and the
client (`apps/client`). It owns the visual language (tokens, type, and
component styles) so both apps look like one product.

## Entry points

| Import                     | Contents                                              |
| -------------------------- | ----------------------------------------------------- |
| `@tearleads/ui/styles.css` | Self-hosted fonts, tokens, base styles, component CSS |
| `@tearleads/ui/react`      | Typed React primitives for the client                 |
| `@tearleads/ui/icons`      | The shared icon vocabulary (Lucide geometry)          |
| `@tearleads/ui/brand`      | Product name, pricing plans, and legal links          |

Import `styles.css` once, before any app stylesheet. The website uses the
same class names directly in Astro markup; the client prefers the React
primitives, which render those classes.

## Rules

- Use tokens (`var(--color-*)`, `var(--space-*)`, `var(--text-*)`,
  `var(--radius-*)`) instead of raw values. App stylesheets should not
  introduce hex colors or pixel font sizes.
- The smallest text is `--text-xs` (12px). Body copy in the app is
  `--text-base` (14px); inputs are `--text-md` (15px, 16px on phones).
- Spacing follows the 4px scale (`--space-1` = 4px … `--space-32` = 128px).
- One button vocabulary everywhere: `.button` plus a variant and size.
- Status is communicated with `Badge`/`.badge` tones, feedback with
  `Banner`/`.banner`; never hand-roll colored pills or alert boxes.
- Class names are camelCase to match the rest of the repository.

## Tokens

Neutrals are warm paper and ink: `--color-paper` (canvas),
`--color-surface` (cards and inputs), `--color-surface-sunken` (wells,
table headers, card footers), `--color-ink` (dark surfaces and primary
buttons). Text uses `--color-text`, `--color-text-muted` (secondary), and
`--color-text-subtle` (metadata). Borders use `--color-border`,
`--color-border-subtle` (row dividers), and `--color-border-strong`
(controls).

The brand accents are `--color-lime` (on dark surfaces and for focus
rings), `--color-lime-soft`/`--color-lime-wash` (highlight surfaces), and
`--color-green`/`--color-green-strong` (links and accents on light
surfaces). Status tones each have `-bg`, `-border`, and `-fg` tokens:
`success`, `warning`, `danger`, `info`, and `neutral`.

Wrap dark regions in `.onDark` so buttons, inputs, eyebrows, and focus
rings switch to their inverse treatment.

## CSS vocabulary

- **Buttons:** `button` + `buttonPrimary`, `buttonAccent`, `buttonGhost`,
  `buttonDanger`, `buttonLink`; `buttonSm`, `buttonLg`, `buttonBlock`,
  `buttonIconOnly`
- **Forms:** `field`, `fieldLabel`, `fieldHint`, `fieldError`,
  `fieldOptional`, `input`, `select`, `textarea`, `inputSm`, `check`,
  `fieldset`, `formGrid`, `formRow`, `formActions`
- **Surfaces:** `card`, `cardHeader`, `cardHeading`, `cardTitle`,
  `cardDescription`, `cardActions`, `cardBody`, `cardFlush`, `cardFooter`,
  `cardInteractive`, `cardSelected`, `cardAccent`, `cardDanger`
- **Rows:** `rowList`, `row`, `rowMain`, `rowTitle`, `rowMeta`, `rowActions`
  (a `button.row` or `a.row` is clickable)
- **Tables:** `tableWrap`, `table`
- **Status:** `badge` + `badgeSuccess`, `badgeWarning`, `badgeDanger`,
  `badgeInfo`, `badgeAccent`, `badgeDot`; `banner` + `bannerSuccess`,
  `bannerWarning`, `bannerDanger`, `bannerNeutral`
- **States:** `emptyState`, `emptyStateCompact`, `emptyStatePlain`, `spinner`
- **Navigation:** `tabs` + `tab` (`aria-current="page"`), `segmented`
  (children use `aria-pressed`/`aria-current`; `data-tone="success"` or
  `"danger"` tints a pressed answer; `segmentedFill` makes equal-width
  options), `popover`, `menuItem`, `menuLabel`, `menuSeparator`
- **Page:** `page`, `pageNarrow`, `pageHeader`, `pageBody`, `pageSection`,
  `sectionHeader`, `sectionTitle`, `sectionDescription`, `sectionCount`
- **Layout:** `stack` (+ `stackXs`…`stackXl`), `cluster` (+ `clusterBetween`),
  `gridAuto` (`--grid-min`)
- **Type:** `display`, `headline`, `title`, `lead`, `eyebrow`, `eyebrowDot`,
  `serifAccent`, `prose`, `textMuted`, `textSubtle`, `textXs`, `textSm`,
  `textStrong`, `mono`, `tabular`, `truncate`
- **Identity:** `brand`, `brandMark`, `avatar` (+ `avatarSm`,
  `avatarLg`), `keyValue`, `codeChip`, `icon`

## React primitives

- `Page` (`narrow` for forms and settings), `PageHeader` (`eyebrow`,
  `title`, `description`, `actions`, `back`, `tabs`), `PageBody`, and
  `PageSection` (`title`, `description`, `actions`).
- `Card` (`title`, `description`, `actions`, `footer`, `flush` for row
  lists and tables, `onSubmit` to render the card as a form). Its title is
  an `h2`, or an `h3` inside a `PageSection`; a lone footer action sits at
  the end.
- `Button` and `ButtonLink` (`variant`, `size`, `icon`, `iconEnd`,
  `iconOnly`, `block`; `Button` also takes `busy`), plus `buttonClass()`
  for other elements.
- `Badge` (`tone`, `dot`), `Banner` (`tone`, `title`, `actions`,
  `announce`), `EmptyState` (`icon`, `title`, `actions`, `compact`,
  `plain`), and `LoadingState`.
- `Field` wraps a control with its label, hint, and an `optional` marker.
- `Icon` renders a name from `@tearleads/ui/icons`; `Avatar` and `Logo`
  render identity.
