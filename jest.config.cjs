// Low-memory Jest config (use: npm run test:lowmem). Production tsconfig untouched.
// Type-check tests separately with: npx tsc --noEmit -p tsconfig.json
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  modulePaths: ['<rootDir>/..'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [require.resolve('ts-jest'), { diagnostics: false, tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  testEnvironment: 'node',
  maxWorkers: 1,
  workerIdleMemoryLimit: '1GB',
  cacheDirectory: '<rootDir>/../.jest-cache',
};


