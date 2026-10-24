# Fonts for the launch image

Static instances of the variable fonts the personal site uses, because Satori reads neither variable
fonts nor WOFF2. Latin subset, cut from the Fontsource variable files with
`fonttools varLib.instancer`:

| File | Source | Axes |
| --- | --- | --- |
| `Fraunces-Roman.ttf` | Fraunces, full, normal | `wght=400 opsz=144 SOFT=30 WONK=1` (the site's headlines) |
| `Fraunces-WonkItalic.ttf` | Fraunces, full, italic | `wght=400 opsz=144 SOFT=100 WONK=1` (each headline word's first letter) |
| `InstrumentSans-Regular.ttf` | Instrument Sans, standard | `wght=400 wdth=100` |
| `InstrumentSans-SemiBold.ttf` | Instrument Sans, standard | `wght=600 wdth=100` |

Both families are under the SIL Open Font License 1.1 (`OFL-*.txt`), with no reserved font name.
