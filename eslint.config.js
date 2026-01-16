const globals = require("globals");
const pluginJs = require("@eslint/js");

module.exports = [
    {
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.commonjs
            },
            sourceType: "commonjs"
        },
        rules: {
            "no-unused-vars": ["warn", {
                "argsIgnorePattern": "^_",
                "varsIgnorePattern": "^_",
                "caughtErrorsIgnorePattern": "^_"
            }],
            "no-undef": "error",
            "no-console": "off",
            "no-empty": ["error", { "allowEmptyCatch": true }]
        }
    },
    pluginJs.configs.recommended,
];
