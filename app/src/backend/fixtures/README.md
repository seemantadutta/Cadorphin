# MockBackend fixtures

`enclosure/` is the output of the `enclosure` template, generated with:

```sh
cadkit new demo --template enclosure
cadkit build demo                      # copy demo/.cad/out/*.glb, *.topo.json and demo/.cad/manifest.json here
cadkit info demo --json > info.json    # then set "root" to "/mock/demo"
```

Regenerate them when the template or the manifest format changes.
