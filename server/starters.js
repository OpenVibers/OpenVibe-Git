'use strict';

/** The three starters a new repository can begin with. No fake content: a README that says what it is. */
const { validPath } = require('./git/refs');

function readme(name, description) {
    return `# ${name}\n\n${description || 'A repository on OpenVibe.Git.'}\n\nClone it with OpenVibe:\n\n\`\`\`sh\ngit clone https://git.openvibe.codes/${name}.git\n\`\`\`\n`;
}

const FILES = {
    empty: ({ full }) => [{ path: 'README.md', content: readme(full) }],
    static: ({ full }) => [
        { path: 'README.md', content: `${readme(full)}\nOpen \`index.html\` in a browser, or publish the folder wherever you host sites.\n` },
        {
            path: 'index.html',
            content: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${full.split('/')[1]}</title>\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n<main>\n<h1>${full.split('/')[1]}</h1>\n<p>Made with OpenVibe.Git.</p>\n</main>\n</body>\n</html>\n`,
        },
        { path: 'style.css', content: ':root{color-scheme:dark light}body{margin:0;font:16px/1.55 system-ui,sans-serif;background:#0b0d12;color:#e6edf7}main{max-width:42rem;margin:12vh auto;padding:0 1.25rem}h1{font-size:clamp(2rem,6vw,3rem);margin:0 0 .5rem}\n' },
    ],
    app: ({ full }) => [
        { path: 'README.md', content: `${readme(full)}\n## Run\n\n\`\`\`sh\nnpm install\nnpm start\n\`\`\`\n\nThe app signs in with OpenVibe (openvibe-sdk/sso) and wears the shared navbar and footer.\n` },
        {
            path: 'package.json',
            content: `${JSON.stringify({
                name: full.split('/')[1], version: '0.1.0', private: true, description: '', main: 'server/index.js',
                scripts: { start: 'node server/index.js', dev: 'NODE_ENV=development node server/index.js' },
                dependencies: { express: '^4.21.2', 'openvibe-sdk': 'https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/v0.108.0', 'openvibe-shared': 'https://codeload.github.com/OpenVibers/OpenVibe.Shared/tar.gz/refs/tags/v4.163.0' },
                engines: { node: '>=22.0.0' },
            }, null, 2)}\n`,
        },
        {
            path: 'server/index.js',
            content: `'use strict';\nconst express = require('express');\nconst { createSsoClient } = require('openvibe-sdk/sso');\n\nconst app = express();\nconst sso = createSsoClient({\n    site: ${JSON.stringify(full.split('/')[1])}, baseUrl: process.env.BASE_URL || 'http://localhost:3000',\n    clientId: process.env.OV_OAUTH_CLIENT_ID, clientSecret: process.env.OV_OAUTH_CLIENT_SECRET,\n    networkUrl: 'https://openvibe.network', secureCookies: /^https:/.test(process.env.BASE_URL || ''),\n});\napp.use('/auth', sso.router(express));\napp.use(sso.optionalAuth());\napp.get('/', (req, res) => res.type('html').send('<h1>Hello</h1>'));\napp.listen(process.env.PORT || 3000);\n`,
        },
        { path: '.gitignore', content: 'node_modules/\ndata/\n.env\n' },
    ],
};

/** files for a starter; `full` is owner/name. */
function starterFiles(kind, { full }) {
    const make = FILES[kind] || FILES.empty;
    return make({ full }).filter((f) => validPath(f.path));
}

module.exports = { starterFiles, FILES };
