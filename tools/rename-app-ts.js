const fs = require('fs');
const path = require('path');

const map = {
  'App.js': 'App.tsx',
  'index.js': 'index.ts',
  'src/api.js': 'src/api.ts',
  'src/model.js': 'src/model.ts',
  'src/CareContext.js': 'src/CareContext.ts',
  'src/commands.js': 'src/commands.ts',
  'src/voice.js': 'src/voice.ts',
  'src/ui.js': 'src/ui.tsx',
  'src/AuthScreen.js': 'src/AuthScreen.tsx',
  'src/DoorScreen.js': 'src/DoorScreen.tsx',
  'src/TodayScreen.js': 'src/TodayScreen.tsx',
  'src/LogScreen.js': 'src/LogScreen.tsx',
  'src/PeopleScreen.js': 'src/PeopleScreen.tsx',
  'src/CareScreen.js': 'src/CareScreen.tsx'
};

const root = path.join(__dirname, '..', 'app');
for (const [from, to] of Object.entries(map)) {
  fs.renameSync(path.join(root, from), path.join(root, to));
}
console.log('renamed');
