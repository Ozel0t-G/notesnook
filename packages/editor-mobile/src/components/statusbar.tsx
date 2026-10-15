/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import React, { RefObject, useEffect, useRef, useState } from "react";
import { getTotalWords, Editor } from "@notesnook/editor";
import { useTabContext } from "../hooks/useTabStore";
import { strings } from "@notesnook/intl";

function StatusBar({
  container,
  loading
}: {
  container: RefObject<HTMLDivElement>;
  loading?: boolean;
}) {
  const tab = useTabContext();
  const [showChars, setShowChars] = useState(false);
  const [words, setWords] = useState(strings.totalWords(0));
  const currentWords = useRef(words);
  const [chars, setChars] = useState(0);
  const statusBar = useRef({
    set: () => {},
    updateWords: () => {
      const editor = editors[tab.id];
      if (!editor) return;
      const words = strings.totalWords(getTotalWords(editor as Editor));
      if (currentWords.current === words) return;
      setWords(words);
    },
    resetWords: () => {
      currentWords.current = strings.totalWords(0);
      setWords(currentWords.current);
    }
  });

  useEffect(() => {
    globalThis.statusBars[tab.id] = statusBar;

    return () => {
      globalThis.statusBars[tab.id] = undefined;
    };
  }, [tab.id, statusBar]);

  useEffect(() => {
    const editor = editors[tab.id];
    if (editor) {
      setChars(editor.extensionStorage.characterCount.characters() || 0);
    }
    if (!showChars || !editor) return;

    // Registered with a stable, captured identity so the cleanup below can
    // unregister exactly this listener (and only this listener) when the
    // character count is toggled off, the tab changes or the component
    // unmounts.
    const onSelectionUpdate = () => {
      setChars(editor.extensionStorage.characterCount.characters() || 0);
    };
    editor.on("selectionUpdate", onSelectionUpdate);

    return () => {
      editor.off("selectionUpdate", onSelectionUpdate);
    };
  }, [tab.id, showChars]);

  useEffect(() => {
    currentWords.current = words;
  }, [words]);

  const paragraphStyle: React.CSSProperties = {
    marginTop: 0,
    marginBottom: 0,
    fontSize: 12,
    color: "var(--nn_secondary_paragraph)",
    paddingBottom: 0,
    fontFamily: "Inter",
    userSelect: "none"
  };

  return (
    <p
      onMouseDown={(e) => {
        setShowChars(!showChars);
      }}
      style={paragraphStyle}
    >
      {showChars ? strings.charactersCount(chars) : words}
    </p>
  );
}

export default React.memo(
  StatusBar,
  (prev, next) => prev.loading === next.loading
);
