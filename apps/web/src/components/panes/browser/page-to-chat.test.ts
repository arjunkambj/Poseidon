import { describe, expect, it } from "vitest";

import {
  appendToDraft,
  onNewDocument,
  parsePicked,
  pickedElementText,
  PICK_SCRIPT,
  screenshotFile,
} from "./page-to-chat";

describe("parsePicked", () => {
  it("takes the picker's answer and nothing else", () => {
    const picked = {
      selector: "#save",
      tag: "button",
      text: "Save",
      html: "<button>Save</button>",
    };
    expect(parsePicked(picked)).toEqual(picked);
    expect(parsePicked(null)).toBe(null);
    expect(parsePicked("#save")).toBe(null);
    expect(parsePicked({ ...picked, selector: "" })).toBe(null);
    expect(parsePicked({ ...picked, tag: 3 })).toBe(null);
    expect(parsePicked({ selector: "a", tag: "a" })).toEqual({
      selector: "a",
      tag: "a",
      text: "",
      html: "",
    });
  });

  it("cuts what the page sends back, whatever it claims", () => {
    const parsed = parsePicked({
      selector: "a",
      tag: "a",
      text: "x".repeat(900),
      html: "y".repeat(9000),
    });
    expect(parsed?.text).toHaveLength(200);
    expect(parsed?.html).toHaveLength(2000);
  });
});

describe("pickedElementText", () => {
  it("names the element, the page, its text and its html", () => {
    expect(
      pickedElementText(
        {
          selector: "main > button.primary",
          tag: "button",
          text: " Save\n now ",
          html: "<button>",
        },
        "http://localhost:5173/",
      ),
    ).toBe(
      [
        "Element `main > button.primary` on http://localhost:5173/",
        'Text: "Save now"',
        "```html",
        "<button>",
        "```",
      ].join("\n"),
    );
  });

  it("leaves out empty text and html", () => {
    expect(pickedElementText({ selector: "div", tag: "div", text: "", html: "" }, "u")).toBe(
      "Element `div` on u",
    );
  });
});

describe("appendToDraft", () => {
  it("starts an empty draft and follows a written one after a blank line", () => {
    expect(appendToDraft("", "x")).toBe("x");
    expect(appendToDraft("  \n", "x")).toBe("x");
    expect(appendToDraft("look at this\n", "x")).toBe("look at this\n\nx");
  });
});

describe("screenshotFile", () => {
  it("is a png named after the host and the time", () => {
    const file = screenshotFile(
      new Uint8Array([1, 2, 3]),
      "https://example.com/a",
      new Date("2026-09-24T10:11:12Z"),
    );
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(3);
    expect(file.name).toBe("screenshot-example.com-2026-09-24-10-11-12.png");
    expect(screenshotFile(new Uint8Array([1]), "about:blank", new Date(0)).name).toMatch(
      /^screenshot-page-/,
    );
  });
});

describe("PICK_SCRIPT", () => {
  it("is one expression the webview can run", () => {
    expect(() => new Function(`return ${PICK_SCRIPT}`)).not.toThrow();
  });
});

describe("onNewDocument", () => {
  it("ends a pick on a new document, never on an in-page navigation or title change", () => {
    const view = new EventTarget();
    let gone = 0;
    const stop = onNewDocument(view, () => (gone += 1));
    view.dispatchEvent(new Event("did-navigate-in-page"));
    view.dispatchEvent(new Event("page-title-updated"));
    expect(gone).toBe(0);
    view.dispatchEvent(new Event("did-navigate"));
    expect(gone).toBe(1);
    stop();
    view.dispatchEvent(new Event("did-navigate"));
    expect(gone).toBe(1);
  });
});
