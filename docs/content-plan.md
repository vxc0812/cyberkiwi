# Help readers understand and act on security stories

Status: proposed. Product decisions are recorded below. The backend work is not built, and the contracts it needs are defined here. The visual pass is in [design-plan.md](design-plan.md).

## Purpose

CyberKiwi helps people and small organizations stay safe while they use connected things: phones, laptops, home routers, smart TVs, cameras, cars, medical devices, payment apps and business accounts. Most readers are not security specialists.

Each story should answer three questions in plain language:

1. What happened?
2. Does it affect me, and which things I own or use?
3. What should I do, in order?

Technical detail stays available for readers who want it, but it is never the first thing they see.

## Audience

In scope:

- **Individuals:** people who use phones, computers, home networks, smart-home devices, connected cars, wearables and online accounts.
- **Small organizations:** businesses and charities with no dedicated security staff, typically 1 to 50 people. Their readers are owners, office managers or whoever handles IT by default.

Out of scope for now: enterprise security operations teams, security researchers and vendors’ own product security staff. They can use the source advisories directly.

The 1-to-50 range is a working definition and needs confirmation (see Open decisions).

## Decided

1. **The AI writes the guidance.** “What happened”, “who is affected” and “what to do” are generated from source articles.
2. **Generation with citations.** Every statement links to the source it came from.
3. **Both views.** Readers can use “For home”, “For business”, “For travel and vehicles”, or “All stories, sorted by risk” (the default).

## Rules for generated guidance

- **Grounded only.** The model receives only retrieved source text. Output without a supporting source is discarded.
- **Citations on every block.** Each summary, each “who is affected” item and each step cites its source: publisher, title, date and link to the original.
- **No source, no guidance.** If a story has no usable source, the card shows the headline and source link only, with the label “Guidance not available yet”. No steps are invented.
- **Labelled as AI-generated.** Every generated block carries the visible text “Written with AI from sources”, linking to the sources. The label is text, never an icon alone.
- **Review and correction.** Each story has “Report a problem with this guidance”. A report sends the story to the review queue and hides its guidance until a reviewer clears it.
- **Reading level.** Generated text must score at or below grade 8 on Flesch-Kincaid. Text above that is regenerated, and if it still fails, it is hidden and the card falls back to the no-guidance state.
- **Safety wording.** Steps never tell a reader to disable a security feature, share a password, or install software from a link. A step that does is dropped by a rule check before display, and the event is logged for review.

## Views

- “For home”, “For business” and “For travel and vehicles” filter the same story set. “All stories, sorted by risk” is the default.
- Audience tags are assigned from the story text and the citations. Each tag is stored with the citation that supports it.
- A story can carry more than one tag.
- The existing topic categories (Vulnerabilities, Vendor advisories, Threat intel and others) stay as a secondary filter inside each view.

## Data contract

### Existing (returned by `/api/v1/stories` today)

- `id`, `title`, `summary` (nullable)
- `articleCount`, `matchedArticleCount`
- `firstPublishedAt`, `lastPublishedAt`
- `sources` (distinct publishers)
- `articles` (up to 10 in a list, each with its source, title and link)
- `articlesTruncated`

### Required for this plan (new)

| Field | Type | Purpose |
| --- | --- | --- |
| `guidance.status` | `ready`, `pending`, `unavailable`, `hidden` | Which card state to show |
| `guidance.whatHappened` | text with citation refs | Plain-language summary |
| `guidance.affected` | list of `{ label, citationRefs }` | Everyday things affected |
| `guidance.steps` | list of `{ text, citationRefs }` | Ordered actions |
| `guidance.generatedAt`, `guidance.model` | timestamp, string | Provenance |
| `guidance.readingGrade` | number | Result of the reading-level check |
| `risk.level` | `urgent`, `act-this-week`, `good-to-know` | Plain risk label |
| `risk.basis` | `cvss`, `vendor`, `review` | Why the label was chosen |
| `audiences` | list of `home`, `business`, `travel-vehicles` | View filters |
| `citations` | list of `{ id, publisher, title, date, url, articleId }` | Sources shown to readers |

`citationRefs` point to entries in `citations`. Every `guidance` text block must have at least one `citationRef`, or it is rejected by the validator.

Current data supports some risk information: NVD articles carry a CVSS score and severity in their snippet text. That is parsed as a signal, not treated as a complete risk model. Affected-device lists and steps do not exist in the data yet.

## Backend work

These are separate from the visual pass and need to be built in this order:

1. **Citation mapping.** Store the source article and text span behind each generated sentence.
2. **Grounding check.** Reject any generated sentence whose citation does not contain a supporting span. Use the retrieved text as the only context for generation.
3. **Safety filter.** A rule set that blocks the unsafe step patterns above (disable security, share password, install from link). Keep the rules in version control with tests.
4. **Reading-level validator.** Compute Flesch-Kincaid per block and store `readingGrade`.
5. **Review queue.** Storage for reports, a reviewer view, actions (clear, edit, hide), and an audit log of every change.
6. **Audience and risk tagging.** Assign tags and risk labels with stored reasons.
7. **Regeneration and provenance.** Store the model and prompt version used for each guidance block, so a bad output can be traced and reverted.
8. **API.** Add `guidance`, `risk` and `audiences` to the story responses, with the filter parameters the views need.

Each step is tested before the next one depends on it.

## Open decisions

1. **Reviewer capacity.** Who reviews reports, how many a week, and what the response target is. The review queue cannot launch without an owner.
2. **Audience size.** Confirm or change the 1-to-50 range for small organizations.
3. **Legal and disclaimer wording.** The guidance is general advice, not professional security advice. The wording, placement and any terms of use need legal review.
4. **Model and data handling.** Confirm which model is used for generation, where requests are processed, and what is stored. The app already uses Gemini server-side; this must be confirmed for guidance generation.
5. **Evaluation set.** A set of stories with expected guidance, used to test grounding, safety and reading level before launch. Who builds it and when.
6. **Risk policy.** How the “Urgent”, “Act this week” and “Good to know” labels are assigned, beyond CVSS, and who owns the policy.
7. **Region and language.** Launch languages and whether guidance is generated per language. The app supports English and Portuguese today.

## Writing rules

- Plain verbs and short sentences. Name things by what the reader uses, such as “your router” rather than “network edge device”.
- Define a technical term once, in a short clause, where it first appears. For example: firmware (the software that runs a device).
- Spell out acronyms on first use, for example Common Vulnerabilities and Exposures (CVE), and use the short form after that.
- Steps begin with a verb: “Change your router password”, not “Remediation of default credentials”.
- Errors and empty states say what happened and what to do next.

## Out of scope

- The visual pass (see [design-plan.md](design-plan.md)).
- Changes to the palette and the reader beyond the grounded-guidance blocks.
- Any change to how sources are fetched and stored, except the citation fields.

## Next steps

1. Settle the open decisions, starting with reviewer capacity and the legal wording.
2. Build the backend contracts in the order above, with tests.
3. Build the story layout, the three views and the review queue against the contract.
4. Run the evaluation set and the plain-language test before any guidance is shown to readers.
