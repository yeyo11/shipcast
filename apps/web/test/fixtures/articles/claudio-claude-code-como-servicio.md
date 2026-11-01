Claude Code vive en una terminal. Está bien hasta que quieres iniciar una conversación desde el móvil, mirar cómo va un agente cuando no estás en tu mesa, o lanzar cinco en paralelo sin perder la pista de cuál necesita una respuesta. Hice Claudio para cubrir ese hueco: ejecuta Claude Code como un servicio.

En este artículo cuento qué es Claudio, cómo habla con Claude Code y cómo se instala.

## Qué te da

Claudio pone la CLI de Claude Code detrás de una API REST y una interfaz web. El mismo servidor sirve a una app de escritorio para Linux y a una web instalable en el móvil. Todo corre en tu máquina o en tu servidor, con tu propio login de Claude.

- Conversaciones que puedes iniciar, seguir y responder desde un navegador o por HTTP.
- Orquestaciones: un grafo de tareas que ejecutan workers en paralelo, cada uno en su propio worktree de git.
- Varias cuentas de Claude, y el trabajo pasa a la que aún tiene cuota.
- Una pantalla para revisar lo que cambiaron los agentes.
- Proyectos con tablero de tareas y un equipo de agentes.

Las voy repasando una a una.

## La regla única: solo la interfaz que la CLI ofrece a los programas

Claudio no lee la pantalla de la terminal, no llama a endpoints sin documentar ni hace un segundo login por su cuenta. Llega a Claude Code por los flags de la CLI, su protocolo de stream y los ficheros que escribe. [docs/cli-surfaces.md](https://github.com/yeyo11/claudio/blob/main/docs/cli-surfaces.md) lista cada superficie en uso, una fila por necesidad. Por ejemplo:

```text
Ejecutar / continuar una conversación  claude -p --input-format stream-json --output-format stream-json
Estado de autenticación                claude auth status --json
Historial de sesiones                  $CLAUDE_CONFIG_DIR/projects/*/*.jsonl
```

La consecuencia práctica es un techo: lo que la CLI no puede hacer, Claudio tampoco. Los artefactos web y la memoria de chat de claude.ai no tienen superficie en la CLI, así que Claudio no los toca.

## Conversaciones por HTTP

Una conversación es un proceso `claude` de larga vida alimentado por stdin, con `--resume` cuando el proceso ya no existe. Puedes iniciarla desde la interfaz o desde la API:

```bash
curl -X POST http://localhost:8797/api/chats \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Añade un test unitario para parseDuration", "cwd": "/workspace/mi-app"}'
```

La petición también acepta `worktree` (ejecutar dentro de un worktree nuevo de git con ese nombre) y `jsonSchema` (salida estructurada). A partir de ahí tienes `POST /api/chats/:id/messages`, `/stop`, `/interrupt`, `/resume` y `/fork`, y `GET /api/chats/:id/stream` para seguirla. Cuando el agente pide un permiso, hace una pregunta o pide aprobar un plan, respondes desde la interfaz (o con `POST /api/chats/:id/permissions/:requestId`).

La referencia interactiva está en `/docs` y el documento OpenAPI 3.1 en `/openapi.json`. Si activaste la autenticación, envía `Authorization: Bearer <token>`.

La interfaz no hace polling. Un único feed de server-sent events, `GET /api/events`, lleva conversaciones, avisos que esperan tu respuesta, tareas, orquestaciones y rotación de cuentas, y se reanuda con `Last-Event-ID` tras un corte.

## Orquestaciones

Una orquestación es un grafo de tareas. Los workers corren en paralelo, cada uno en su propio worktree de git, y sus ramas se integran en una rama de integración. Después, una fase de verificación ejecuta tus comprobaciones (build, tests) sobre esa rama con un tiempo límite, y se puede ofrecer una pull request. Existe como ruta `POST /api/orchestrations` y como pantalla donde sigues la ejecución por pasos.

Dos cosas a tener en cuenta: las comprobaciones necesitan `worktree: true` en el motor de grafo, y los workers no sobreviven a un reinicio. Una tarea que pilla uno queda `interrupted` y su conversación sigue en una ejecución nueva mientras le queden intentos.

## Varias cuentas, rotadas

Cada cuenta de Claude tiene su propio `CLAUDE_CONFIG_DIR` y se inicia sesión una sola vez. Claudio lee el uso por ventana, pasa el trabajo nuevo a una cuenta con cuota antes de llegar al límite, repite en la siguiente cuenta un turno que choca con el límite, y espera al reinicio solo cuando ninguna tiene cuota. También hay una CLI pequeña, `claudio-accounts`, en `packages/accounts`.

## Revisar los cambios dentro de Claudio

Para una conversación, una tarea o la rama de integración hay una pantalla de diff construida a partir de git y de la transcripción. Cada edición lleva la frase que Claude escribió justo antes, así que lees el cambio junto con su motivo.

## Proyectos, tablero y equipo

Puedes importar un directorio como proyecto. Obtiene un tablero de Tareas con elementos de trabajo (claves tipo `AGN-12`, cinco columnas fijas, épicas, hitos) y un equipo donde cada miembro es un fichero de agente de Claude Code con un rol. Con el flujo activado, una tarjeta que entra en una columna inicia la ejecución de ese rol. Solo tú mueves una tarjeta a Hecho.

## Guardas

Claudio puede añadir hooks `PreToolUse` que se cumplen incluso en `bypassPermissions`: sin push, sin `--no-verify`, sin borrado recursivo fuera del worktree, sin escribir secretos. Están activos para los workers de las orquestaciones y para el flujo, y se configuran por proyecto en las conversaciones. El mecanismo es un fichero de ajustes con solo los hooks de Claudio, pasado con `--settings`. Mira [docs/guards.md](https://github.com/yeyo11/claudio/blob/main/docs/guards.md).

## Instalación

**Docker** (amd64):

```bash
docker run -d --init --name claudio --restart unless-stopped -p 127.0.0.1:8797:8797 \
  -v claudio-config:/home/node/.claude -v claudio-data:/data -v claudio-workspace:/workspace \
  ghcr.io/yeyo11/claudio
```

Abre `http://localhost:8797`, entra con el token de propietario que el contenedor imprimió una sola vez (`docker logs claudio`) e inicia sesión en Claude desde el asistente de configuración. Nombra los tres volúmenes; si no, al reemplazar el contenedor para actualizar empiezas con volúmenes vacíos.

**App de escritorio** (Linux x86_64, `.deb` o AppImage):

```bash
curl -fsSL https://raw.githubusercontent.com/yeyo11/claudio/main/scripts/install.sh | bash
```

Como con cualquier script que se pasa a un shell, léelo antes. La app corre con tu propio `claude` y tu login de `~/.claude`, así que no hay sandbox y las conversaciones empiezan en `acceptEdits`.

**Desde el código** (Node 22+, pnpm 10 y un `claude` con sesión iniciada en el `PATH`):

```bash
git clone https://github.com/yeyo11/claudio && cd claudio
pnpm install
pnpm dev          # API en :8797, UI en :5181
```

Después: abre Claudio, deja que el asistente compruebe Claude Code, pulsa Nuevo chat, elige un directorio y escribe un prompt.

## Antes de exponerlo

Un contenedor crea un token de propietario en su primer arranque. Una instalación desde el código o la app de escritorio tienen la autenticación desactivada hasta que la actives. Eso es correcto para un puerto ligado a `127.0.0.1` e incorrecto para cualquier otra cosa: sin autenticación, cualquiera que llegue al puerto puede iniciar una conversación en tu cuenta y leer todas las transcripciones de la máquina. Los modos son `none`, `token` (solo se guarda el SHA-256) y `oidc` (Claudio valida un JWT; no inicia sesión a nadie). Claudio no termina TLS, así que pon un proxy delante. [docs/securing.md](https://github.com/yeyo11/claudio/blob/main/docs/securing.md) tiene los detalles.

Claudio es un fork de Agentry solo para Claude, un proyecto independiente y sin relación con Anthropic.

## Qué viene

El roadmap dice que ahora mismo no hay nada planificado. Lo que queda se descartó por ahora, con sus motivos: shells nativos para las tiendas de apps, push por usuario, uso sin conexión, un flujo de login en navegador para OIDC. Si alguna de esas te importa, abre una issue y cuéntame por qué.

El código tiene licencia MIT en [github.com/yeyo11/claudio](https://github.com/yeyo11/claudio).
