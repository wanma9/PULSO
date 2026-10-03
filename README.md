# PULSO

Demo local de telemetria urbana para comparar consultas de series temporales entre PostgreSQL estandar y PostgreSQL con TimescaleDB. El frontend consulta las dos APIs y muestra sus datos en el mismo dashboard.

## Estado y procedencia de los datos

El dashboard obtiene sus lecturas y agregados de las dos bases de datos; no genera datos de muestra en el navegador ni sustituye una API desconectada por valores ficticios. Cada API emite un evento Server-Sent Events (SSE) después de insertar correctamente una tanda. Al recibirlo, el navegador vuelve a consultar esa API, sin sondeo periódico de las lecturas.

La consola de consultas ejecuta benchmarks al cargar el dashboard y los actualiza cada 30 segundos. Cada API envía sus consultas de prueba a su propia base mediante `EXPLAIN (ANALYZE, FORMAT JSON)` y muestra el `Execution Time` informado por el motor. Es tiempo interno de ejecución, no latencia HTTP de extremo a extremo. `EXPLAIN ANALYZE` ejecuta la consulta y devuelve el plan, no las filas de su `SELECT`. Las consultas de ambos motores son parecidas, pero algunas agrupaciones difieren; sus tiempos no representan una comparación estrictamente idéntica.

## Arquitectura

```text
Navegador (Vite / TanStack Start, puerto 5173)
  +-- API PostgreSQL estandar (puerto 4001) -- PostgreSQL (puerto 5433)
  +-- API TimescaleDB (puerto 4002) --------- TimescaleDB (puerto 5434)
```

Cada API ejecuta el mismo simulador: genera lecturas sintéticas para 500 sensores y cinco métricas, con una tanda cada 2 segundos por defecto (2.500 filas por tanda; aproximadamente 1.250 filas/s por base). Las tandas se alinean a intervalos comunes de reloj y sus valores se generan de forma determinista a partir de la marca de tiempo. Por eso, las filas de cada tanda coinciden mientras ambas APIs y bases estén disponibles y tengan el mismo `SIMULATOR_INTERVAL_MS`. Si una API o base está detenida, puede faltar una tanda en esa base. Las tandas de cada API se ejecutan en serie para evitar acumular escrituras.

En TimescaleDB, `sensor_readings` se convierte en hypertable, con chunks de 5 minutos y política de compresión para chunks elegibles de más de 5 minutos. PostgreSQL estándar usa una tabla e índices normales. Los datos se conservan en volúmenes Docker.

Para que el historial empiece limpio y se genere con el simulador sincronizado, se pueden reinicializar ambas bases. **Esto borra permanentemente todos los datos de ambos volúmenes.** No es necesario hacerlo para sincronizar las nuevas tandas:

```powershell
docker compose down -v
docker compose up -d --build
```

## Requisitos

- Git
- Node.js 22 LTS y npm
- Docker Desktop con Docker Compose v2

## Instalar Docker en Windows

Abre PowerShell como administrador. Si WSL 2 no está instalado, instala WSL y reinicia Windows cuando lo solicite:

```powershell
wsl --install
```

Después del reinicio, comprueba que WSL está disponible:

```powershell
wsl --update
wsl --status
```

Instala Docker Desktop con WinGet:

```powershell
winget install --id Docker.DockerDesktop -e --accept-source-agreements --accept-package-agreements
```

Abre Docker Desktop desde el menú Inicio y espera a que indique que el motor está en ejecución. En Settings, habilita **Use the WSL 2 based engine** si todavía no está habilitado. Verifica la instalación desde PowerShell:

```powershell
docker --version
docker compose version
docker info
```

Si WinGet no está disponible, instala Docker Desktop desde [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/). La virtualización de hardware debe estar habilitada; en equipos administrados puede requerirse autorización de IT.

## Arranque desde cero

1. Clona el repositorio y entra en la carpeta:

   ```sh
   git clone <URL_DEL_REPOSITORIO>
   cd pulso
   ```

2. Comprueba que Docker Desktop esta iniciado y levanta las dos bases de datos y las APIs:

   ```sh
   docker compose up -d --build
   ```

   La primera ejecución descarga imágenes y compila la API; puede tardar unos minutos. Al inicializar volúmenes vacíos se ejecutan los scripts SQL de `backend/sql`. Al arrancar, cada API también comprueba/crea la tabla y los índices y, en modo TimescaleDB, asegura la hypertable. Después comienza a insertar en los siguientes límites comunes del intervalo de 2 segundos.

3. Instala las dependencias del frontend e inicia Vite:

   ```sh
   npm install
   npm run dev
   ```

4. Abre la URL que muestre Vite, normalmente [http://localhost:5173](http://localhost:5173). El frontend espera que las dos APIs esten en `localhost:4001` y `localhost:4002`.

No hace falta instalar por separado las dependencias de `backend` al usar Docker Compose: la imagen de la API las instala durante la compilacion.

## Comprobar que esta funcionando

Comprueba el estado de los contenedores:

```sh
docker compose ps
```

Comprueba que cada API responde y esta conectada a la base correcta:

```sh
curl http://localhost:4001/health
curl http://localhost:4002/health
```

Las respuestas deben incluir `"status":"ok"`; la primera debe indicar modo `plain` y la segunda `timescale`. En PowerShell se pueden comprobar con:

```powershell
Invoke-RestMethod http://localhost:4001/health
Invoke-RestMethod http://localhost:4002/health
```

Las primeras tandas se insertan en los siguientes límites comunes del intervalo configurado (2 segundos por defecto). Si las bases acaban de arrancar, espera unos segundos y recarga el dashboard para ver lecturas recientes.

### Comparar datos y filas entre las dos bases

Desde PowerShell, en la raiz del proyecto, ejecuta:

```powershell
.\scripts\compare-databases.ps1
```

El script compara el tamaño lógico de cada base (`pg_database_size`), el número exacto de filas, tiempos y sensores distintos, rango temporal y, por métrica, recuento y valores mínimo, medio y máximo. Los recuentos exactos recorren la tabla y pueden tardar o consumir CPU en bases grandes. El tamaño lógico no necesariamente coincide con el tamaño del volumen Docker, que también contiene WAL y otros archivos. Necesita Docker Desktop y los contenedores `pulse-postgres-plain` y `pulse-postgres-timescale` activos. Si ambas APIs estuvieron disponibles, las tandas sincronizadas deben producir datos idénticos; cualquier interrupción puede causar diferencias en el historial. El script compara resúmenes, no verifica igualdad fila por fila.

Para consultar las últimas 20 filas de cada base en paralelo:

```powershell
.\scripts\query_comparacion_bbdd.ps1
```

Este script muestra también el nombre de cada base (`pulse_timescale` y `pulse_plain`). Para comprobar igualdad exacta de las tablas se necesita comparar las filas completas, no solo los conteos o los agregados.

## Puertos y endpoints

| Servicio | URL local | Proposito |
| --- | --- | --- |
| Frontend | `http://localhost:5173` | Dashboard web |
| API PostgreSQL | `http://localhost:4001` | Datos y consultas de la base estandar |
| API TimescaleDB | `http://localhost:4002` | Datos y consultas de TimescaleDB |
| PostgreSQL | `localhost:5433` | Conexion directa a la base estandar |
| TimescaleDB | `localhost:5434` | Conexion directa a TimescaleDB |

En ambas APIs están disponibles `GET /health`, `GET /api/config`, `GET /api/overview`, `GET /api/dashboard?range=5m`, `GET /api/events`, `GET /api/series`, `GET /api/alerts` y `GET /api/queries/performance`. Los rangos del dashboard son `1m`, `5m`, `1h`, `24h` y `7d`. `/api/events` mantiene una conexión SSE y emite `readings-inserted` después de cada inserción correcta. `/api/queries/performance` mide ejecución en el motor mediante `EXPLAIN (ANALYZE, FORMAT JSON)`, por lo que informa tiempo interno, no latencia HTTP; el plan sustituye las filas normales del `SELECT`. Por ejemplo:

```text
http://localhost:4001/api/series?metric=temperature&window=10m
http://localhost:4002/api/queries/performance
```

## Operacion habitual

Ver logs de todos los servicios o de uno concreto:

```sh
docker compose logs -f
docker compose logs -f api-timescale
```

Parar contenedores conservando las bases de datos:

```sh
docker compose down
```

Volver a arrancarlos:

```sh
docker compose up -d
```

Eliminar tambien los datos persistidos y empezar con bases vacias (**esta accion borra los volumenes de ambas bases**):

```sh
docker compose down -v
docker compose up -d --build
```

Los scripts SQL de `backend/sql` se ejecutan automáticamente al inicializar un volumen vacío; no se vuelven a ejecutar al reiniciar un volumen ya existente. `backend/src/db.ts` también asegura la extensión TimescaleDB cuando corresponde, la tabla, la hypertable y los índices al arrancar la API. Esa comprobación no aplica la política de compresión: esta se configura en `backend/sql/init-timescale.sql` durante la inicialización de un volumen Timescale vacío.

## Desarrollo y compilacion

Frontend:

```sh
npm run build
npm run lint
```

Backend (si se ejecuta o compila fuera de Docker):

```sh
cd backend
npm install
npm run build
```

Para ejecutar una API localmente sin Docker, primero proporciona una instancia compatible de PostgreSQL/TimescaleDB, copia `.env.example` a `.env` y configura `DB_MODE`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `PORT` y `CORS_ORIGIN`. El frontend sigue necesitando ambas APIs para la comparacion.

## Despliegue fuera de la maquina local

El Compose incluido es un entorno de demostracion local, no una configuracion lista para produccion. El frontend tiene las direcciones `http://localhost:4001` y `http://localhost:4002` definidas en el cliente; antes de publicarlo hay que sustituirlas por las direcciones HTTPS de las APIs. Tambien hay que restringir `CORS_ORIGIN` al origen real del frontend, cambiar las credenciales de ejemplo, proteger los puertos de base de datos y definir copias de seguridad y persistencia apropiadas.

El frontend se construye con `npm run build`, pero el destino de produccion depende del adaptador de TanStack Start/Nitro configurado en `vite.config.ts`. El backend produce JavaScript ejecutable con `npm run build` en `backend`. No se incluye aqui una plataforma concreta (por ejemplo, Azure, Cloudflare o un servidor propio); para desplegar alli hay que configurar el adaptador y la infraestructura correspondiente.

## Estructura relevante

- `src/routes/index.tsx`: dashboard y lecturas del frontend hacia ambas APIs.
- `src/components/charts.tsx`: componentes SVG de graficas.
- `backend/src/index.ts`: API Express y endpoints.
- `backend/src/db.ts`: conexion y creacion/verificacion del esquema.
- `backend/src/simulator.ts`: generador de trafico de demostracion.
- `backend/sql/init-plain.sql`: esquema inicial de PostgreSQL.
- `backend/sql/init-timescale.sql`: extension e hypertable de TimescaleDB.
- `backend/README.md`: notas adicionales de la API.
- `docker-compose.yml`: topologia local de bases y APIs.
