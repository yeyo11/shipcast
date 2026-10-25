import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookOf, parseProjects, withCover } from '../src/index.ts';

const TEXT = `# Known projects
claudio:
  colour: "#2FD7A0"
  motif: phone
  cover: /covers/claudio.jpg
shipcast:
  colour: "#FFD43B"
  motif: label
`;

test('projects.yml parses, and an empty file is an empty list', () => {
  const parsed = parseProjects(TEXT);
  assert.ok(parsed.ok);
  assert.deepEqual(Object.keys(parsed.value), ['claudio', 'shipcast']);
  const empty = parseProjects('');
  assert.ok(empty.ok);
  assert.deepEqual(empty.value, {});
});

test('a bad colour is reported on its line', () => {
  const parsed = parseProjects('claudio:\n  colour: green\n  motif: phone\n');
  assert.ok(!parsed.ok);
  assert.equal(parsed.issues[0]?.line, 2);
});

test('lookOf gives what the blog and the first Shipcast gave: the listed projects, then the hash', () => {
  const parsed = parseProjects(TEXT);
  assert.ok(parsed.ok);
  const projects = parsed.value;
  assert.deepEqual(lookOf(projects, 'claudio'), { colour: '#2FD7A0', motif: 'phone', cover: '/covers/claudio.jpg' });
  assert.deepEqual(lookOf(projects, 'Shipcast'), { colour: '#FFD43B', motif: 'label' });
  // Today's outputs for names that are not listed
  assert.deepEqual(lookOf(projects, 'orca'), { colour: '#FF7A2F', motif: 'stack' });
  assert.deepEqual(lookOf(projects, 'Pando'), { colour: '#FF6FAE', motif: 'orb' });
  // Inherited object keys are not projects
  assert.deepEqual(lookOf({}, 'constructor'), lookOf({}, 'constructor'));
  assert.ok(lookOf({}, 'constructor').colour.startsWith('#'));
});

test('withCover sets the cover keeping the file, and lists an unlisted project with its current look', () => {
  const parsed = parseProjects(TEXT);
  assert.ok(parsed.ok);
  const updated = withCover(TEXT, parsed.value, 'shipcast', '/covers/shipcast.jpg');
  assert.match(updated, /^# Known projects/);
  const again = parseProjects(updated);
  assert.ok(again.ok);
  assert.equal(again.value.shipcast?.cover, '/covers/shipcast.jpg');
  assert.equal(again.value.shipcast?.colour, '#FFD43B');

  const added = parseProjects(withCover(TEXT, parsed.value, 'orca', '/covers/orca.jpg'));
  assert.ok(added.ok);
  assert.deepEqual(added.value.orca, { colour: '#FF7A2F', motif: 'stack', cover: '/covers/orca.jpg' });

  const fromNothing = parseProjects(withCover(undefined, {}, 'orca', '/covers/orca.jpg'));
  assert.ok(fromNothing.ok);
  assert.deepEqual(fromNothing.value.orca, { colour: '#FF7A2F', motif: 'stack', cover: '/covers/orca.jpg' });
});
