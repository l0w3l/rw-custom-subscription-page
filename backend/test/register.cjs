// Compile application TypeScript with its actual compiler options for Node's test runner.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
require.extensions['.ts'] = (module, filename) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { ...options, module: ts.ModuleKind.CommonJS, sourceMap: false },
        fileName: filename,
    });
    module._compile(outputText, filename);
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request.startsWith('@common/')) request = path.join(root, 'src/common', request.slice(8));
    return resolve.call(this, request, ...args);
};
