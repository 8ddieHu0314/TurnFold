/**
 * TurnFold regression tests: run src/content.js inside jsdom against the DOM
 * shapes claude.ai has shipped (or could ship) and assert that folding,
 * outline building, and API alignment behave.
 *
 *   cd tests && npm install && npm test
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name);
  if (!cond) failures++;
}

function boot(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://claude.ai/chat/aaaa-bbbb-cccc',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.__TF_TEST__ = {};
  window.eval(SRC);
  return { window, tf: window.__TF_TEST__, doc: window.document };
}

function collapseTurn(tf, i) {
  const turns = tf.collectTurns();
  const state = {};
  state[turns[i].key] = true;
  tf.setCollapsed(state);
  tf.scan();
  return turns;
}

const hidden = (doc, sel) => {
  const el = doc.querySelector(sel);
  return !!(el && el.classList.contains('tf-hidden'));
};
const coveredByHidden = (doc, sel) => {
  const el = doc.querySelector(sel);
  return !!(el && el.closest('.tf-hidden'));
};

// ---------------------------------------------------------------------------
console.log('1. Flat siblings: [U][A][U][A]');
{
  const { tf, doc } = boot(`
    <main><div id="list">
      <div id="u1" data-test-render-count="1"><div data-testid="user-message"><p>Q1 hello</p></div></div>
      <div id="a1" data-test-render-count="1"><div>Answer one</div></div>
      <div id="u2" data-test-render-count="1"><div data-testid="user-message"><p>Q2 world</p></div></div>
      <div id="a2" data-test-render-count="1"><div>Answer two</div></div>
    </div></main>`);
  const turns = tf.collectTurns();
  check('finds 2 turns', turns.length === 2);
  check('labels from first line', turns[0].label === 'Q1 hello' && turns[1].label === 'Q2 world');
  collapseTurn(tf, 0);
  check('A1 hidden', hidden(doc, '#a1'));
  check('U2 not hidden', !hidden(doc, '#u2') && !coveredByHidden(doc, '#u2'));
  check('A2 not hidden', !hidden(doc, '#a2'));
  check('U1 marked collapsed', doc.querySelector('#u1').classList.contains('tf-collapsed'));
  collapseTurn(tf, 1);
  check('collapse t1: A2 hidden, A1 restored', hidden(doc, '#a2') && !hidden(doc, '#a1'));
}

// ---------------------------------------------------------------------------
console.log('2. Deep nesting, single turn (structure from the live diagnostic)');
{
  const { tf, doc } = boot(`
    <main><div id="list">
      <div id="qbranch"><div><div data-test-render-count="1">
        <div><div><div><div><div><div data-testid="user-message">Q1 deep</div></div></div></div></div></div>
      </div></div></div>
      <div id="abranch"><div><div data-test-render-count="1" data-is-streaming="false">
        <div>Answer content</div>
      </div></div></div>
    </div></main>`);
  const turns = tf.collectTurns();
  check('finds 1 turn', turns.length === 1);
  collapseTurn(tf, 0);
  check('answer branch hidden', coveredByHidden(doc, '#abranch [data-test-render-count]') || hidden(doc, '#abranch'));
  check('question still visible', !coveredByHidden(doc, '[data-testid="user-message"]'));
}

// ---------------------------------------------------------------------------
console.log('3. Deep nesting, multi turn');
{
  const { tf, doc } = boot(`
    <main><div id="list">
      <div id="b1"><div><div data-test-render-count="1"><div><div data-testid="user-message">Q1</div></div></div></div></div>
      <div id="b2"><div><div data-test-render-count="1"><div>A1</div></div></div></div>
      <div id="b3"><div><div data-test-render-count="1"><div><div data-testid="user-message">Q2</div></div></div></div></div>
      <div id="b4"><div><div data-test-render-count="1"><div>A2</div></div></div></div>
    </div></main>`);
  const turns = tf.collectTurns();
  check('finds 2 turns', turns.length === 2);
  collapseTurn(tf, 0);
  check('A1 branch hidden', hidden(doc, '#b2') || coveredByHidden(doc, '#b2 [data-test-render-count]'));
  check('Q2/A2 untouched', !coveredByHidden(doc, '#b3 [data-testid="user-message"]') && !hidden(doc, '#b4') && !coveredByHidden(doc, '#b4 [data-test-render-count]'));
  collapseTurn(tf, 1);
  check('collapse t1: A2 hidden, A1 restored', (hidden(doc, '#b4') || coveredByHidden(doc, '#b4 [data-test-render-count]')) && !hidden(doc, '#b2') && !coveredByHidden(doc, '#b2 [data-test-render-count]'));
}

// ---------------------------------------------------------------------------
console.log('4. Pair-grouped: [g(U,A)][g(U,A)]');
{
  const { tf, doc } = boot(`
    <main><div id="list">
      <div id="g1">
        <div id="g1u" data-test-render-count="1"><div data-testid="user-message">Q1</div></div>
        <div id="g1a" data-test-render-count="1"><div>A1</div></div>
      </div>
      <div id="g2">
        <div id="g2u" data-test-render-count="1"><div data-testid="user-message">Q2</div></div>
        <div id="g2a" data-test-render-count="1"><div>A2</div></div>
      </div>
    </div></main>`);
  const turns = tf.collectTurns();
  check('finds 2 turns', turns.length === 2);
  collapseTurn(tf, 0);
  check('A1 hidden inside its group', hidden(doc, '#g1a'));
  check('group 2 fully untouched', !hidden(doc, '#g2') && !hidden(doc, '#g2u') && !hidden(doc, '#g2a'));
  collapseTurn(tf, 1);
  check('collapse t1: A2 hidden', hidden(doc, '#g2a'));
}

// ---------------------------------------------------------------------------
console.log('5. Safety: composer / nav / next question are never hidden');
{
  const { tf, doc } = boot(`
    <main><div id="list">
      <div id="qb"><div data-test-render-count="1"><div data-testid="user-message">Q only</div></div></div>
      <div id="ab"><div data-test-render-count="1"><div>Answer</div></div></div>
      <div id="composer"><form><textarea></textarea></form></div>
    </div></main>`);
  collapseTurn(tf, 0);
  check('answer hidden', hidden(doc, '#ab') || coveredByHidden(doc, '#ab [data-test-render-count]'));
  check('composer NOT hidden', !hidden(doc, '#composer') && !coveredByHidden(doc, '#composer textarea'));
}

// ---------------------------------------------------------------------------
console.log('6. Expand-after-collapse restores everything');
{
  const { tf, doc } = boot(`
    <main><div id="list">
      <div id="u1" data-test-render-count="1"><div data-testid="user-message"><p>Q1</p></div></div>
      <div id="a1" data-test-render-count="1"><div>A1</div></div>
    </div></main>`);
  collapseTurn(tf, 0);
  check('collapsed first', hidden(doc, '#a1'));
  tf.setCollapsed({});
  tf.scan();
  check('nothing hidden after expand', doc.querySelectorAll('.tf-hidden').length === 0);
  check('anchor not marked collapsed', !doc.querySelector('#u1').classList.contains('tf-collapsed'));
}

// ---------------------------------------------------------------------------
console.log('7. API alignment: UUID keys, virtualized outline, duplicate labels');
{
  const { tf, doc } = boot(`
    <main><div id="list">
      <div id="u1" data-test-render-count="1"><div data-testid="user-message"><p>continue pls</p></div></div>
      <div id="a1" data-test-render-count="1"><div>A2</div></div>
      <div id="u2" data-test-render-count="1"><div data-testid="user-message"><p>continue pls</p></div></div>
      <div id="a2" data-test-render-count="1"><div>A3</div></div>
    </div></main>`);
  tf.setFullTurns([
    { uuid: 'aaa', label: 'first question', norm: 'firstquestion' },
    { uuid: 'bbb', label: 'continue pls', norm: 'continuepls' },
    { uuid: 'ccc', label: 'continue pls', norm: 'continuepls' },
    { uuid: 'ddd', label: 'unloaded tail', norm: 'unloadedtail' },
  ]);
  tf.scan();
  const turns = tf.getTurns();
  check('twins matched in order', turns[0].key === 'u:bbb' && turns[1].key === 'u:ccc');

  const items = tf.outlineItems();
  check('outline lists full history', items.length === 4);
  check('unloaded entries marked ghost', items[0].mounted === false && items[3].mounted === false);
  check('mounted entries not ghost', items[1].mounted === true && items[2].mounted === true);

  tf.setCollapsed({ 'u:bbb': true });
  tf.scan();
  check('uuid fold hides first twin answer only', hidden(doc, '#a1') && !hidden(doc, '#a2'));

  tf.setAll(true);
  const c = tf.getCollapsed();
  check('collapse-all includes unloaded uuids', c['u:aaa'] === true && c['u:ddd'] === true);
}

// ---------------------------------------------------------------------------
console.log('8. normText matches DOM textContent (glued paragraphs) to API text (newlines)');
{
  const { tf } = boot('<main><div data-test-render-count="1"><div data-testid="user-message"><p>hello</p><p>world</p></div></div></main>');
  check('whitespace-free norm aligns both sides',
    tf.normText('hello\nworld') === tf.normText('helloworld'));
}

// ---------------------------------------------------------------------------
console.log('9. Paste-chip message still matches its API record (containment)');
{
  const { tf } = boot(`
    <main><div id="list">
      <div data-test-render-count="1"><div data-testid="user-message"><p>nice analogy and explanation, now tell me more about it</p></div></div>
      <div data-test-render-count="1"><div>A</div></div>
      <div data-test-render-count="1"><div data-testid="user-message"><p>you should try to match my style:</p><div class="chip">PASTED 2.1kb here is my long pasted style example content</div></div></div>
      <div data-test-render-count="1"><div>A</div></div>
      <div data-test-render-count="1"><div data-testid="user-message"><p>great, now what do you think is a better approach</p></div></div>
      <div data-test-render-count="1"><div>A</div></div>
    </div></main>`);
  const norm = (s) => tf.normText(s);
  tf.setFullTurns([
    { uuid: 'q4', label: 'nice analogy and explanation, no…', norm: norm('nice analogy and explanation, now tell me more about it') },
    { uuid: 'q5', label: 'you should try to match my style:', norm: norm('you should try to match my style:') },
    { uuid: 'q6', label: 'great, now what do you think is a …', norm: norm('great, now what do you think is a better approach') },
  ]);
  tf.scan();
  check('chip message matched to its uuid', tf.getTurns()[1].key === 'u:q5');
  const items = tf.outlineItems();
  check('no duplicate entry appended', items.length === 3);
  check('entry sits at position 2 and is mounted', items[1].key === 'u:q5' && items[1].mounted === true);
}

// ---------------------------------------------------------------------------
console.log('10. Just-sent message (no API record, no successor) lands at the end');
{
  const { tf } = boot(`
    <main><div id="list">
      <div data-test-render-count="1"><div data-testid="user-message"><p>first known question</p></div></div>
      <div data-test-render-count="1"><div>A</div></div>
      <div data-test-render-count="1"><div data-testid="user-message"><p>a brand new just-sent question the API has not returned yet</p></div></div>
      <div data-test-render-count="1"><div>A</div></div>
    </div></main>`);
  const norm = (s) => tf.normText(s);
  tf.setFullTurns([
    { uuid: 'k1', label: 'first known question', norm: norm('first known question') },
    { uuid: 'k2', label: 'unloaded old tail', norm: norm('some entirely different unloaded question text') },
  ]);
  tf.scan();
  const items = tf.outlineItems();
  check('just-sent turn (no successor) listed at the very end',
    items.length === 3 && items[0].key === 'u:k1' && items[1].key === 'u:k2' &&
    items[2].mounted === true && !items[2].key.startsWith('u:'));
}

// ---------------------------------------------------------------------------
console.log('11. Paste-chip with two-sided tails matches via common prefix');
{
  const { tf } = boot(`
    <main><div id="list">
      <div data-test-render-count="1"><div data-testid="user-message"><p>you should try to match my style:</p><div>PASTED 2.1kb</div></div></div>
      <div data-test-render-count="1"><div>A</div></div>
      <div data-test-render-count="1"><div data-testid="user-message"><p>great, now what do you think is a better approach</p></div></div>
      <div data-test-render-count="1"><div>A</div></div>
    </div></main>`);
  const norm = (s) => tf.normText(s);
  tf.setFullTurns([
    { uuid: 'p5', label: 'you should try to match my style:', norm: norm('you should try to match my style: def my_function(x): return x * 2 # this is the long pasted style example that goes on') },
    { uuid: 'p6', label: 'great, now what do you think is a …', norm: norm('great, now what do you think is a better approach') },
  ]);
  tf.scan();
  check('two-sided divergence matched by prefix', tf.getTurns()[0].key === 'u:p5');
  check('no duplicate outline entry', tf.outlineItems().length === 2);
}

// ---------------------------------------------------------------------------
console.log('12. Outline order is stable regardless of which neighbours are loaded');
{
  const norm = (s) => 'zz' + s; // opaque norms that match nothing in the DOM
  const api = [
    { uuid: 's1', label: 'first', norm: norm('1') },
    { uuid: 's2', label: 'second', norm: norm('2') },
    { uuid: 's3', label: 'third', norm: norm('3') },
  ];
  const domA = `
    <main><div id="list">
      <div data-test-render-count="1"><div data-testid="user-message"><p>totally unmatched question text here</p></div></div>
      <div data-test-render-count="1"><div>A</div></div>
      <div data-test-render-count="1"><div data-testid="user-message"><p>third</p></div></div>
      <div data-test-render-count="1"><div>A</div></div>
    </div></main>`;
  const a = boot(domA);
  a.tf.setFullTurns(api.map((x) => x.uuid === 's3' ? { ...x, norm: a.tf.normText('third') } : x));
  a.tf.scan();
  const orderA = a.tf.outlineItems().map((x) => x.key.startsWith('u:') ? x.key : 'UNMATCHED');
  const domB = `
    <main><div id="list">
      <div data-test-render-count="1"><div data-testid="user-message"><p>second</p></div></div>
      <div data-test-render-count="1"><div>A</div></div>
      <div data-test-render-count="1"><div data-testid="user-message"><p>totally unmatched question text here</p></div></div>
      <div data-test-render-count="1"><div>A</div></div>
      <div data-test-render-count="1"><div data-testid="user-message"><p>third</p></div></div>
      <div data-test-render-count="1"><div>A</div></div>
    </div></main>`;
  const b = boot(domB);
  b.tf.setFullTurns(api.map((x) =>
    x.uuid === 's3' ? { ...x, norm: b.tf.normText('third') } :
    x.uuid === 's2' ? { ...x, norm: b.tf.normText('second') } : x));
  b.tf.scan();
  const orderB = b.tf.outlineItems().map((x) => x.key.startsWith('u:') ? x.key : 'UNMATCHED');
  check('same order in both scroll states', JSON.stringify(orderA) === JSON.stringify(orderB));
  check('unmatched pinned just before its successor',
    JSON.stringify(orderA) === JSON.stringify(['u:s1', 'u:s2', 'UNMATCHED', 'u:s3']));
}

// ---------------------------------------------------------------------------
console.log('13. Queued/pending message near the composer never becomes a turn');
{
  // Mimics the live repro: a user-message with NO render-count wrapper next
  // to the composer, while real turns have wrappers.
  const { tf, doc } = boot(`
    <main><div id="list">
      <div data-test-render-count="1"><div data-testid="user-message"><p>real question</p></div></div>
      <div data-test-render-count="1"><div>Answer</div></div>
    </div>
    <div id="pending"><div data-testid="user-message"><p>queued message</p></div></div>
    <div id="composer"><form><div contenteditable="true">Write a message…</div></form></div>
    </main>`);
  tf.scan();
  check('only the real question is a turn', tf.getTurns().length === 1);
  check('no toggle on the pending block', !doc.querySelector('#pending .tf-toggle'));
}

// ---------------------------------------------------------------------------
console.log('14. Edit-in-place box (user-message inside a form) is skipped');
{
  const { tf, doc } = boot(`
    <main><div id="list">
      <div id="w1" data-test-render-count="1"><form><div contenteditable="true" data-testid="user-message">editing this question…</div></form></div>
      <div data-test-render-count="1"><div>Answer</div></div>
      <div id="w2" data-test-render-count="1"><div data-testid="user-message"><p>second question</p></div></div>
      <div data-test-render-count="1"><div>Answer</div></div>
    </div></main>`);
  tf.scan();
  const turns = tf.getTurns();
  check('message under edit is not a turn', turns.length === 1 && turns[0].userWrapper.id === 'w2');
  check('no toggle injected into the edit form', !doc.querySelector('#w1 .tf-toggle'));
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
