function replaceAiSdkNodeDynamicImport({ types: t }) {
  return {
    name: "replace-ai-sdk-node-dynamic-import",
    visitor: {
      CallExpression(path, state) {
        if (!String(state.filename).includes("@ai-sdk/provider-utils/dist/index.mjs")) return;
        if (path.node.callee.type !== "Import") return;
        const [specifier] = path.node.arguments;
        if (t.isStringLiteral(specifier)) return;
        path.replaceWith(
          t.callExpression(t.memberExpression(t.identifier("Promise"), t.identifier("reject")), [
            t.newExpression(t.identifier("Error"), [
              t.stringLiteral("Node modules are unavailable in the Paseo app runtime"),
            ]),
          ]),
        );
      },
    },
  };
}

module.exports = function (api) {
  api.cache(true);

  const expoPreset = [
    "babel-preset-expo",
    {
      // Transform `import.meta` for ALL platforms (web + native)
      // Required for modern ESM deps like Zustand 5 that use import.meta.env
      unstable_transformImportMeta: true,
    },
  ];

  return {
    presets: [expoPreset],
    plugins: [
      replaceAiSdkNodeDynamicImport,
      [
        "react-native-unistyles/plugin",
        {
          root: "src",
        },
      ],
    ],
  };
};
