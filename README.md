# playwright-harness

A framework-agnostic Playwright test harness. It shows your running app in an
iframe, lets you click elements to build Playwright steps, and writes the test
code for you.

The harness serves its own UI and proxies your dev server, so the app iframe is
same-origin and can be inspected - no framework integration, no app changes, no
dependencies.

The idea is to get more people writing e2e and making it easier.

## Usage

Start your app's dev server, then:

```bash
npx playwright-harness -- --app http://localhost:5173 --tests ./your-e2e-tests-directory
```

Open <http://localhost:5180/harness>.

| Option    | Default                 | Meaning                                          |
| --------- | ----------------------- | ------------------------------------------------ |
| `--app`   | `http://localhost:5173` | Your running dev server                          |
| `--port`  | `5180`                  | Port for the harness and the proxy               |
| `--tests` | `tests`                 | Directory searched (recursively) for `*.spec.ts` |

The iframe path is relative (so `http://localhost:5173/route`, will just show `/route`).

## What it does

- **Pick element** - click inside the app and the selector is filled in. It
  prefers the nearest `data-testid`, then `id`, then `name`, then a CSS path.
- **Record** - press **Record** and use the app as normal: clicks, typing, keys
  and navigation become steps. Alt+click records `expect visible`, Shift+click
  records `expect text` from the element's text, Ctrl/Cmd+click records an
  element screenshot with an automatic path, and **Screenshot page** captures
  the page. **Record network** also records the requests each action triggers,
  as `page.waitForResponse(...)` waits paired with that action. A click on a
  `<label>` is recorded against the control its `for` attribute names.
- **Selector typeahead** - lists every `data-testid` in the current page and
  filters as you type.
- **Test IDs** - outlines every `data-testid` element, stepping through a colour
  ramp per nesting level so overlaps stay readable.
- **Steps** - `goto`, `click`, `fill`, `press`, `expect visible`, `expect text`,
  page and element screenshots, shown as readable summaries. The camera icon takes
  a page screenshot after the step, the framed icon turns on element picking and
  test ids so you can choose the element to screenshot after the step, and the dot
  sets a breakpoint before it. Both save under `<tests dir>/<suite>/` as
  `<step>-<testid>.png` (element shots add `-element`), where the suite is the
  spec file of the test loaded from the Tests tab. A `!` marks steps recorded at
  the same moment, such as a label and the control it forwards the click to.
  Drag a step onto another to reorder them.
- **Replay** - runs the step list inside the iframe: navigations, clicks, fills,
  presses, assertions and recorded response waits, with a configurable delay
  between steps. Click the dot
  next to a step to set a breakpoint; replay pauses before it and **Continue**
  resumes. The current step is highlighted in the list, and a ring is drawn
  around the element about to be clicked or otherwise interacted with.
  Screenshots are skipped because Playwright is not running in the
  harness; a failed step stops the replay with a message.
- **Code** - the generated Playwright test, importable as `saveScreenshot` /
  `saveElementScreenshot` from `./utils/screenshot`. The **Scenario name** field
  sets the test title and the screenshot folder, defaulting to `harness-test`.
- **Tests** - every `*.spec.ts` under the tests directory, with its test titles
  and source. **Load** turns a test's supported statements back into steps in the
  Actions tab and reports lines it could not represent (`getByRole`, waits,
  title/URL assertions).

## New Workflow

1. **Start** - Hit Record, and run through your test scenario as you would normally
2. **Actions** - the steps get populated as you test, with each step's action and selector being recorded
3. **Replay** - run the test to see if it still works or if there are steps that are flakey or excessive (it helps to pay attention while the steps are added)
4. **Code** - the generated Playwright test can be copied and saved as a new scenario

## Existing Workflow

1. **Load** - In the Tests tab, you can find existing tests and load them into the Actions tab
2. **Edit** - If something is not working (a selector has been updated or the flow has changed)
3. **Record** - Add additional steps to a scenario as needed

You may have your own tests already that aren't compatible with how this tool writes them. I prefer data-testid selectors for more robust tests.

## Screenshot Utils

```ts
// /utils/screenshot.ts
import type { Page } from '@playwright/test';

/** Saves a full-page screenshot to the given path. */
export async function saveScreenshot(page: Page, path: string) {
	await page.screenshot({ path, fullPage: true });
}

/** Saves a screenshot of the element matching the selector to the given path. */
export async function saveElementScreenshot(page: Page, selector: string, path: string) {
	await page.locator(selector).screenshot({ path });
}
```

Add this to your e2e test folder to use the screenshotting features.

## Things to be aware of

Certain components may cause multiple events to be triggered from a single click, for example, elements that toggle would toggle on in your testing, but in the replay it toggles on and immediately off.

## Notes

- The generated code imports the screenshot helpers from `./utils/screenshot`,
  which assumes the spec lives at the tests root.
- The proxy forwards HTTP only. The app's HMR websocket will not connect through
  the harness, so edits reload only when you press **Reload**.
- Requires Node 18+.

## License

MIT
