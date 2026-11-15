import { describe, expect, test } from 'bun:test'
import {
  MAX_ROUNDS,
  REVIEW_MARKER,
  commentableLines,
  openChangeRequests,
  ownReviews,
  parseVerdict,
  planReview,
  type Review,
} from './code-review'

const BOT = 'flytower-code-reviewer[bot]'
const review = (over: Partial<Review>): Review => ({
  id: 1,
  user: { login: BOT },
  state: 'COMMENTED',
  body: `Looks fine.\n${REVIEW_MARKER}`,
  commit_id: 'abc',
  ...over,
})

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 
 export { a }
@@ -20,2 +21,2 @@ function f() {
-  return 1
+  return 2
 }
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/new.md b/new.md
new file mode 100644
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+# Title
+text
\\ No newline at end of file
`

describe('commentableLines', () => {
  test('takes added and context lines on the new side', () => {
    const lines = commentableLines(PATCH)
    expect([...lines.get('src/a.ts')!].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 21, 22])
    expect([...lines.get('new.md')!]).toEqual([1, 2])
  })

  test('skips deleted files', () => {
    expect(commentableLines(PATCH).has('old.ts')).toBe(false)
  })
})

describe('own reviews', () => {
  test('only counts reviews from the bot that carry the marker', () => {
    const reviews = [
      review({ id: 1 }),
      review({ id: 2, user: { login: 'MattA-Official' } }),
      review({ id: 3, body: 'no marker' }),
      review({ id: 4, state: 'CHANGES_REQUESTED' }),
    ]
    expect(ownReviews(reviews, BOT).map((r) => r.id)).toEqual([1, 4])
    expect(openChangeRequests(reviews, BOT).map((r) => r.id)).toEqual([4])
  })

  test('a dismissed request no longer counts as open', () => {
    expect(openChangeRequests([review({ state: 'DISMISSED' })], BOT)).toEqual([])
  })
})

describe('planReview', () => {
  const lines = commentableLines(PATCH)
  const meta = { round: 2, headSha: '0123456789abcdef' }

  test('puts findings on changed lines inline and the rest in the body', () => {
    const plan = planReview(
      {
        verdict: 'request_changes',
        summary: 'Two things.',
        findings: [
          { path: 'src/a.ts', line: 3, body: 'Off by one.' },
          { path: 'src/other.ts', line: 9, body: 'Callers need updating too.' },
        ],
      },
      lines,
      meta,
    )
    expect(plan.event).toBe('REQUEST_CHANGES')
    expect(plan.comments).toEqual([
      { path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Off by one.' },
    ])
    expect(plan.body).toContain('`src/other.ts:9`: Callers need updating too.')
    expect(plan.body).toContain(`Round 2 of ${MAX_ROUNDS} · reviewed 0123456`)
    expect(plan.body).toContain(REVIEW_MARKER)
  })

  test('a comment verdict with no findings is still a review', () => {
    const plan = planReview({ verdict: 'comment', summary: '', findings: [] }, lines, meta)
    expect(plan.event).toBe('COMMENT')
    expect(plan.comments).toEqual([])
    expect(plan.body.startsWith('Reviewed.')).toBe(true)
  })
})

describe('parseVerdict', () => {
  test('keeps well-formed findings and drops the rest', () => {
    const v = parseVerdict(
      JSON.stringify({
        verdict: 'comment',
        summary: 'ok',
        findings: [
          { path: 'a.ts', line: 1, body: 'x' },
          { path: 'a.ts', line: 1.5, body: 'x' },
          { path: 'a.ts', line: 2, body: '  ' },
          { line: 3, body: 'x' },
        ],
      }),
    )
    expect(v.findings).toEqual([{ path: 'a.ts', line: 1, body: 'x' }])
  })

  test('refuses an unknown verdict, so nothing can approve', () => {
    expect(() => parseVerdict('{"verdict":"approve","summary":"","findings":[]}')).toThrow()
  })
})
