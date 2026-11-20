# Visual pass: calm, readable story cards

Status: proposed, not implemented. Product and content decisions (AI-written guidance, citations, audience views, review workflow) are in [content-plan.md](content-plan.md) and are out of scope here.

## Scope

This pass changes typography, casing, metadata presentation, corner radius and reading hierarchy. It does not change content, data, navigation structure, the reader or the palette.

The pass is one coordinated change, because type size, line height and radius affect every card and every label.

## Direction

CyberKiwi is read by people who are not security specialists. The visual direction is a calm, plain reading surface: generous line height, one clear hierarchy per card, and no decoration that competes with the text. The interface should reassure without alarming.

Memorable element: the **What to do** panel. It is the only surface in a story card with a tinted background and numbered steps in the display face. A reader always knows where the action is.

## Palette

Keep the existing values. They are named here so the pass can be checked against them.

| Name | Hex | Role |
| --- | --- | --- |
| Base dark | `#0a0b0e` | Page background, dark theme |
| Surface dark | `#262626` | Card background, dark theme (`neutral-800`) |
| Text dark | `#f5f5f5` | Primary text, dark theme (`neutral-100`) |
| Secondary dark | `#a3a3a3` | Secondary text, dark theme (`neutral-400`) |
| Page light | `#f5f5f5` | Page background, light theme (`neutral-100`) |
| Secondary light | `#525252` | Secondary text, light theme (`neutral-600`) |
| Accent | `#f97316` | Default accent, overridden by the accent presets |

Measured contrast, computed from these values:

- `#a3a3a3` on `#0a0b0e`: 7.80:1
- `#a3a3a3` on `#262626`: 6.00:1
- `#525252` on `#ffffff`: 7.81:1
- `#525252` on `#f5f5f5`: 7.17:1
- `#f97316` focus ring on `#0a0b0e`: 7.02:1

Not measured yet: the risk-label pairs. They are measured during implementation, and any pair under 4.5:1 for text is changed before merge.

## Layout concept

Desktop (1440px): a single column of story cards with a fixed reading measure, and the filter bar above it.

```
+--------------------------------------------------------------+
| CyberKiwi            [Search]                    [Settings]  |
+--------------------------------------------------------------+
| All stories  For home  For business  For travel and vehicles |
+--------------------------------------------------------------+
| Filter: [Urgent] [Act this week] [Good to know]              |
|                                                              |
| +----------------------------------------------------------+ |
| | Headline in the display face                              | |
| | Source name · Date                                        | |
| | Summary text, about 70 characters per line                | |
| |                                                           | |
| | +------------------------------------------------------+  | |
| | | What to do                                           |  | |
| | | 1  Change the router password                        |  | |
| | | 2  Turn on automatic updates                         |  | |
| | +------------------------------------------------------+  | |
| |                                                           | |
| | [Details]                                                 | |
| +----------------------------------------------------------+ |
+--------------------------------------------------------------+
```

Mobile (390px): the same order, one card per row, filters in a horizontal scroll with every option labelled, and the What to do panel full width inside the card margins.

Alignment: left-aligned text throughout. Centered text is limited to empty states.

## Typography

| Role | Family | Used for | Weights |
| --- | --- | --- | --- |
| Display | Plus Jakarta Sans | Headlines and section headings | 600, 700 |
| Body | Inter | Summaries, labels, controls, navigation | 400, 500, 600 |
| Utility | JetBrains Mono | Technical values only, inside Details | 400 |

Why these faces: Plus Jakarta Sans has open, rounded terminals that read as friendly without being decorative. Inter is designed for interface text at small sizes and has clear letter shapes for people reading on phones. JetBrains Mono keeps CVE IDs and version numbers unambiguous, which matters because a single character can change the meaning of a technical value. All three are under the SIL Open Font License.

Asset plan: install `@fontsource/plus-jakarta-sans`, `@fontsource/inter` and `@fontsource/jetbrains-mono`, pinned to exact versions (the current release on npm is 5.3.0 for each). Copy only the WOFF2 files for the Latin subset and the weights in the table into `public/fonts/`. Declare them in `src/index.css` with `font-display: swap`. Confirm in the built output that no font is fetched from a third-party host.

Fallback stacks:

- Display: `"Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- Body: `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- Utility: `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

Rules:

- Load only the weights in the table, so the browser never synthesizes one.
- Size scale: 14px for secondary text and metadata (the floor for anything a reader needs), 16px for body and summaries, 18px for the steps in What to do, 22px for card headings, 28px for the page heading.
- Line height: 1.25 for headings, 1.55 for body.
- Summary measure: about 70 characters per line.

## Casing

Sentence case applies to labels, buttons, headings, navigation and empty states. The exceptions below are kept as published.

| Element | Rule | Example |
| --- | --- | --- |
| Labels, buttons, headings, navigation | Sentence case | “For home”, “Change your password” |
| CVE identifiers | As published | `CVE-2026-1234` |
| Established acronyms | Uppercase | CVSS, KEV, EPSS, VPN, USB |
| Product and brand names | As the vendor writes them | iPhone, Wi-Fi, macOS |
| Source names | As the publisher writes them | CISA, Microsoft Security Response Center |
| Risk labels | Sentence case | “Urgent”, “Act this week”, “Good to know” |
| Decorative uppercase | Removed | `uppercase tracking-wider` on headings and source labels |

The current inventory is 86 `uppercase` class uses in `src/`. Each one is reviewed against this table, and only the decorative ones are removed.

## Radius

The Tailwind v4 defaults used in this project are: `rounded-xs` 2px, `rounded-sm` 4px, `rounded` 4px, `rounded-md` 6px, `rounded-lg` 8px, `rounded-xl` 12px, `rounded-2xl` 16px, `rounded-3xl` 24px. The current use counts in `src/` are: `rounded-xl` 78, `rounded-2xl` 58, `rounded` 37, `rounded-lg` 26, `rounded-full` 14, `rounded-3xl` 10, `rounded-md` 4.

Tokens are defined in `src/index.css` with Tailwind’s `@theme`, so they generate utilities:

| Token | Value | Utility | Replaces | Use |
| --- | --- | --- | --- | --- |
| `--radius-hero` | 24px | `rounded-hero` | `rounded-3xl` (10 uses) | Banners and the page-level hero |
| `--radius-card` | 16px | `rounded-card` | `rounded-2xl` (58 uses) | Story cards and panels |
| `--radius-control` | 12px | `rounded-control` | `rounded-xl` (78 uses) | Buttons, inputs, menus |
| `--radius-chip` | 8px | `rounded-chip` | `rounded-lg` (26 uses) | Badges, chips, risk labels |

Unchanged: `rounded-full` (14 uses) for dots, avatars and pills, and `rounded` (4px, 37 uses) for small inline marks such as checkboxes. Those two are documented exceptions.

Each replacement is checked at its use site. A `rounded-xl` on a card, or a `rounded-2xl` on a button, moves to the token for its role, not its old value. Nested surfaces follow the outer-radius rule: inner radius equals outer radius minus padding.

## Metadata

- Replace the `•` and `·` separators (47 instances in `.tsx`) with grouped inline elements. Groups are separated by 16px and items within a group by 8px.
- Source name, date and severity are each their own element.
- At 390px, a group stays on one line where it fits. Groups wrap only at group boundaries.

## Hierarchy within a card

1. Headline (22px, display face).
2. Source and date (14px, secondary colour).
3. Summary (16px, body face).
4. What to do panel (steps at 18px, display-face numbers).
5. Details (collapsed, 14px, utility face for technical values).

## Data this pass depends on

The visual pass uses only fields the story API already returns: `title`, `summary`, `sources`, `articles` (with each article’s source and date), and `lastPublishedAt`. It does not depend on risk levels, affected-device lists, steps or CVE fields. Those are defined in [content-plan.md](content-plan.md). Until they exist, the What to do panel and the risk labels are hidden, and the card shows the headline, source, date and summary only.

## Implementation order

1. Install the three font packages at exact versions. Copy the WOFF2 files, declare `@font-face`, and set the families and fallback stacks on the root. No component changes.
2. Add the four radius tokens in `@theme`. Replace the classes listed above, checking each use site.
3. Replace decorative uppercase using the casing table.
4. Replace the metadata separators with grouped elements.
5. Apply the size scale and line heights to the card hierarchy.
6. Run `tsc --noEmit`, `npm test` and `npm run build`.

## Verification

Each item is a check to run after implementation. None is verified yet.

- **Widths:** 1440px, 1024px and 390px. Headlines, summaries, metadata groups and the filter bar must not clip, overlap or force horizontal scroll.
- **200% zoom:** no content clipped or unreachable at 320px CSS width.
- **Themes:** light and dark. Re-measure the secondary text pairs and any risk-label pairs. Any text pair under 4.5:1 is changed before merge.
- **Keyboard:** tab through the card list, the filter bar and one open story. Each control shows a visible focus ring.
- **Reduced motion:** with `prefers-reduced-motion: reduce`, the ticker is static and no layout motion remains.
- **Fonts:** the built app loads the three families from local files only. No request to a third-party font host.
- **Build:** `tsc --noEmit`, `npm test` and `npm run build` pass.

Verification uses the dev server and browser screenshots. Anything that cannot be run is reported as Not verified.

## Out of scope

- The palette, including the near-black base and the default orange accent.
- Data, API and content changes, including AI guidance, citations, audience views and review workflow (see [content-plan.md](content-plan.md)).
- Navigation structure and the reader, beyond the typography and radius changes.
