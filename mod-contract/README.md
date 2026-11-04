# mod-contract

The formats shared by **ModManager** (this workspace) and **ModCatalog**
(`C:\Users\Admin\Documents\ModCatalog`, which vendors a copy of this folder).
Neither repo owns the contract alone: change it here, regenerate the fixtures,
sync the copy, and make every implementation's conformance tests pass.

| file | what |
|---|---|
| `trailer-spec.md` | the `.utoc` metadata trailer: binary layout, payload JSON, read/write algorithms, error kinds |
| `catalog.md` | the catalog JSON a mod manager fetches: canonical shape for writers, lenient rules for readers |
| `catalog.schema.json` | the canonical catalog shape (JSON Schema) |
| `package-spec.md` | which zip members / loose files form one installable mod |
| `upload.md` | the bearer-token upload endpoint contract |
| `tags.json` | the tag vocabulary (ModManager embeds it; ModCatalog filters with it) |
| `fixtures/` | conformance cases every implementation runs |
| `tools/sync.py` | copy this folder to a vendored location, or `--check` it |
| `tools/schema_check.py` | stdlib validator for `catalog.schema.json` |

## Who implements what

| contract | implementations | conformance test |
|---|---|---|
| trailer read/write | C# `io-trailer/` (reference), Python `ModCatalog/trailer.py`, JS `ModCatalog/site/trailer.js` | `io-trailer.Tests/ConformanceTests.cs`, `ModCatalog/tests/test_contract.py`, `ModCatalog/worker/test/contract.test.js` |
| catalog reading | C# `ModManager/Net/CatalogParser.cs` | `ModManager.Tests/ContractTests.cs` |
| catalog writing | `ModCatalog/build.py`, `example_server/` | schema checks in `ModCatalog/tests/test_contract.py` |
| package shape | C# `ModManager/Install/PackageRules.cs`, Python `ModCatalog/build.py`, JS `ModCatalog/site/upload-lib.js` (raw sets) | the same three test files |
| tags | `ModManager/Models/TagCatalog.cs`, `ModCatalog/build.py`, `ModCatalog/site/upload.html` | `ContractTests.cs`, `test_contract.py` |
| upload | ModCatalog `worker/`, C# `ModManager/Net/UploadClient.cs`, `site/upload.html` | worker tests, `NetClientTests.cs` |

**The C# reference is the arbiter** for the trailer: if it disagrees with a
fixture, the fixture is wrong.

## Changing the contract

1. Edit the spec / `tags.json` / schema here.
2. Trailer cases: edit and run `python mod-contract/fixtures/generate.py`
   (an independent encoder, so it can also build deliberately broken files).
   Package and catalog cases are hand-written JSON.
3. `dotnet test io-trailer.Tests` and `dotnet test ModManager.Tests`.
4. `python mod-contract/tools/sync.py ../ModCatalog/mod-contract`, then in
   ModCatalog `python -m unittest` and `cd worker && node --test`.

ModCatalog's tests fail when its copy differs from this one (checked only
when both repos sit side by side, as on the dev machine).
