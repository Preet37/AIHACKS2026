let extensionFontsLoaded = false;

const fontUrl = (path: string) => {
  try {
    return chrome.runtime.getURL(path);
  } catch {
    return `/${path}`;
  }
};

export const loadExtensionFonts = () => {
  if (extensionFontsLoaded || typeof FontFace === "undefined" || !document.fonts) return;
  extensionFontsLoaded = true;

  const faces = [
    new FontFace("JetBrains Mono", `url("${fontUrl("fonts/JetBrainsMono-Regular.woff2")}")`, {
      weight: "400"
    }),
    new FontFace("JetBrains Mono", `url("${fontUrl("fonts/JetBrainsMono-Medium.woff2")}")`, {
      weight: "500"
    }),
    new FontFace("Silkscreen", `url("${fontUrl("fonts/Silkscreen-Regular.woff2")}")`, {
      weight: "400"
    })
  ];

  for (const face of faces) {
    face
      .load()
      .then((loaded) => document.fonts.add(loaded))
      .catch(() => undefined);
  }
};
