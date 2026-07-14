#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import yaml from 'js-yaml';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(message) {
  process.stderr.write(`env manifest validation failed: ${message}\n`);
  process.exit(1);
}

function validateEntries(value) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail('the document root must be a key/value mapping');
  }

  const entries = Object.create(null);
  for (const [key, entryValue] of Object.entries(value)) {
    if (!ENV_KEY.test(key)) fail(`invalid environment variable key: ${key}`);
    if (typeof entryValue !== 'string') {
      fail(`environment variable value must be a string: ${key}`);
    }
    entries[key] = entryValue;
  }
  return entries;
}

function parseYaml(contents) {
  try {
    return validateEntries(yaml.load(contents, {
      json: false,
      schema: yaml.FAILSAFE_SCHEMA,
    }));
  } catch (error) {
    if (error && typeof error.message === 'string'
      && error.message.startsWith('env manifest validation failed:')) {
      throw error;
    }
    fail('invalid YAML mapping or duplicate key');
  }
}

function parseDotenv(contents) {
  const seen = new Set();
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    if (!match) {
      fail(`unsupported ENV syntax on line ${index + 1}`);
    }
    if (seen.has(match[1])) fail(`duplicate environment variable key: ${match[1]}`);
    seen.add(match[1]);
  }

  let parsed;
  try {
    parsed = parseEnv(contents);
  } catch {
    fail('invalid ENV syntax');
  }
  const entries = validateEntries(parsed);
  if (Object.keys(entries).length !== seen.size
    || Object.keys(entries).some((key) => !seen.has(key))) {
    fail('ENV parser key set did not match the validated assignments');
  }
  return entries;
}

const file = process.argv[2];
if (!file || process.argv.length !== 3) fail('expected exactly one manifest path');

let contents;
try {
  contents = fs.readFileSync(file, 'utf8');
} catch {
  fail('manifest could not be read');
}

const extension = path.extname(file).toLowerCase();
const entries = extension === '.yaml' || extension === '.yml'
  ? parseYaml(contents)
  : parseDotenv(contents);
process.stdout.write(`${JSON.stringify(entries)}\n`);
