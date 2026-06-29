import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyTemplate,
  applyCursorTemplate,
  buildClassFileContent,
  buildInterfaceFileContent,
  buildNamespace,
  DEFAULT_ENUM_TEMPLATE,
  DEFAULT_RAZOR_TEMPLATE,
  DEFAULT_RECORD_TEMPLATE,
  DEFAULT_STRUCT_TEMPLATE,
  generateEnum,
  generateRazor,
  generateRecord,
  generateStruct,
} from "../src/solutionExplorer/csharpTemplates.js";

describe("buildNamespace", () => {
  it("uses just the project name when the target is the project root", () => {
    const result = buildNamespace("App", "/repo/App", "/repo/App");

    assert.equal(result, "App");
  });

  it("appends subfolder segments to the project name", () => {
    const result = buildNamespace("App", "/repo/App", "/repo/App/Models/Dto");

    assert.equal(result, "App.Models.Dto");
  });

  it("handles Windows-style backslash paths", () => {
    const result = buildNamespace("App", "C:\\repo\\App", "C:\\repo\\App\\Services");

    assert.equal(result, "App.Services");
  });

  it("falls back to just the project name when the target is outside the root", () => {
    const result = buildNamespace("App", "/repo/App", "/elsewhere/Foo");

    assert.equal(result, "App");
  });
});

describe("buildClassFileContent", () => {
  it("generates a file-scoped namespace and a public class with cursor placeholder", () => {
    const result = buildClassFileContent("App.Models", "Customer");

    assert.equal(result, "namespace App.Models;\n\npublic class Customer\n{\n    ${cursor}\n}\n");
  });
});

describe("buildInterfaceFileContent", () => {
  it("generates a file-scoped namespace and a public interface with cursor placeholder", () => {
    const result = buildInterfaceFileContent("App.Contracts", "IRepository");

    assert.equal(result, "namespace App.Contracts;\n\npublic interface IRepository\n{\n    ${cursor}\n}\n");
  });
});

describe("applyTemplate", () => {
  it("replaces all four variables", () => {
    const result = applyTemplate(
      "${namespace} ${name} ${filename} ${date}",
      "My.Ns",
      "MyClass",
      "MyClass",
      "2026-06-28",
    );

    assert.equal(result, "My.Ns MyClass MyClass 2026-06-28");
  });

  it("replaces each variable multiple times", () => {
    const result = applyTemplate(
      "${name}/${name}",
      "Ns",
      "Foo",
      "Foo",
      "2026-01-01",
    );

    assert.equal(result, "Foo/Foo");
  });

  it("leaves unreferenced variables intact if not present in template", () => {
    const result = applyTemplate(
      "namespace ${namespace};",
      "App",
      "Foo",
      "Foo",
      "2026-06-28",
    );

    assert.equal(result, "namespace App;");
  });
});

describe("generateRecord", () => {
  it("uses the default template", () => {
    const result = generateRecord("App.Models", "MyRecord");

    assert.match(result, /^namespace App\.Models;/);
    assert.match(result, /public record MyRecord\(/);
  });

  it("substitutes ${namespace} and ${name} in the default template", () => {
    const result = generateRecord("App", "Order");

    assert.equal(result, DEFAULT_RECORD_TEMPLATE.replace("${namespace}", "App").replace("${name}", "Order"));
  });

  it("uses a custom template when provided", () => {
    const result = generateRecord("App", "Foo", "// ${namespace}\nrecord ${name};");

    assert.equal(result, "// App\nrecord Foo;");
  });

  it("${filename} includes .cs extension in the default generate flow", () => {
    const result = generateRecord("App", "Bar", "${filename}");

    assert.equal(result, "Bar.cs");
  });
});

describe("generateEnum", () => {
  it("uses the default template", () => {
    const result = generateEnum("App.Enums", "Status");

    assert.match(result, /public enum Status/);
  });

  it("substitutes ${namespace} and ${name} correctly", () => {
    const result = generateEnum("App", "Color");

    assert.equal(result, DEFAULT_ENUM_TEMPLATE.replace("${namespace}", "App").replace("${name}", "Color"));
  });

  it("uses a custom template when provided", () => {
    const result = generateEnum("App", "Color", "enum ${name} {}");

    assert.equal(result, "enum Color {}");
  });
});

describe("generateStruct", () => {
  it("uses the default template", () => {
    const result = generateStruct("App.Data", "Point");

    assert.match(result, /public struct Point/);
  });

  it("substitutes ${namespace} and ${name} correctly", () => {
    const result = generateStruct("App", "Vec3");

    assert.equal(result, DEFAULT_STRUCT_TEMPLATE.replace("${namespace}", "App").replace("${name}", "Vec3"));
  });

  it("uses a custom template when provided", () => {
    const result = generateStruct("App", "Vec3", "struct ${name} {}");

    assert.equal(result, "struct Vec3 {}");
  });

  it("includes ${date} when referenced in a custom template", () => {
    const result = generateStruct("App", "Vec3", "${date}");

    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("generateRazor", () => {
  it("uses the default template", () => {
    const result = generateRazor("App.Components", "Counter");

    assert.match(result, /@namespace App\.Components/);
    assert.match(result, /<h3>Counter<\/h3>/);
    assert.match(result, /@code \{/);
  });

  it("substitutes ${namespace} and ${name} correctly", () => {
    const result = generateRazor("App", "MyComponent");

    assert.equal(
      result,
      DEFAULT_RAZOR_TEMPLATE.replace("${namespace}", "App").replace("${name}", "MyComponent"),
    );
  });

  it("uses a custom template when provided", () => {
    const result = generateRazor("App", "Foo", "@namespace ${namespace}\n<${name} />");

    assert.equal(result, "@namespace App\n<Foo />");
  });

  it("${filename} includes .razor extension in the default generate flow", () => {
    const result = generateRazor("App", "Bar", "${filename}");

    assert.equal(result, "Bar.razor");
  });
});

describe("applyCursorTemplate", () => {
  it("returns content without the cursor marker and its offset", () => {
    const { content, cursorOffset } = applyCursorTemplate(
      "namespace ${namespace};\n\npublic class ${name}\n{\n    ${cursor}\n}\n",
      "App",
      "Foo",
      "Foo.cs",
      "2026-06-28",
    );

    assert.equal(content, "namespace App;\n\npublic class Foo\n{\n    \n}\n");
    assert.equal(cursorOffset, "namespace App;\n\npublic class Foo\n{\n    ".length);
  });

  it("returns undefined cursorOffset when template has no ${cursor}", () => {
    const { content, cursorOffset } = applyCursorTemplate(
      "namespace ${namespace};",
      "App",
      "Foo",
      "Foo.cs",
      "2026-06-28",
    );

    assert.equal(content, "namespace App;");
    assert.equal(cursorOffset, undefined);
  });

  it("positions cursor correctly when ${cursor} appears after other substitutions", () => {
    const { content, cursorOffset } = applyCursorTemplate(
      "${name}:${cursor}",
      "Ns",
      "MyClass",
      "MyClass.cs",
      "2026-06-28",
    );

    assert.equal(content, "MyClass:");
    assert.equal(cursorOffset, "MyClass:".length);
  });

  it("substitutes all other variables before locating the cursor", () => {
    const { content, cursorOffset } = applyCursorTemplate(
      "${namespace}.${name}(${cursor})",
      "App.Models",
      "Order",
      "Order.cs",
      "2026-06-28",
    );

    assert.equal(content, "App.Models.Order()");
    assert.equal(cursorOffset, "App.Models.Order(".length);
  });
});
