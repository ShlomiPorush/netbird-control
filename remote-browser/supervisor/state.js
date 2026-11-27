'use strict';

const fs = require('node:fs');

function memoryStore() {
  let nextSlot = null;
  return {
    load: () => nextSlot,
    save: (slot) => {
      nextSlot = slot;
    },
  };
}

function fileStore(file, log) {
  const temporary = `${file}.tmp`;
  return {
    load() {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') log(`state ${file}: could not read it: ${error.message}`);
        return null;
      }
      let state;
      try {
        state = JSON.parse(text);
      } catch {
        log(`state ${file}: not valid JSON; starting at slot 0`);
        return null;
      }
      if (!Number.isInteger(state?.nextSlot)) {
        log(`state ${file}: nextSlot is not an integer; starting at slot 0`);
        return null;
      }
      return state.nextSlot;
    },
    save(nextSlot) {
      fs.writeFileSync(temporary, JSON.stringify({ nextSlot }), { mode: 0o600, flag: 'w' });
      fs.renameSync(temporary, file);
    },
  };
}

module.exports = { fileStore, memoryStore };
