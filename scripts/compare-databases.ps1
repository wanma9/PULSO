param(
  [string]$PlainContainer = "pulse-postgres-plain",
  [string]$TimescaleContainer = "pulse-postgres-timescale"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "No se encontró Docker. Comprueba que Docker Desktop está instalado y en ejecución."
}

$summaryQuery = @"
WITH metric_stats AS (
  SELECT
    metric,
    COUNT(*) AS rows,
    ROUND(AVG(value)::numeric, 2) AS avg_value,
    MIN(value) AS min_value,
    MAX(value) AS max_value
  FROM sensor_readings
  GROUP BY metric
)
SELECT json_build_object(
  'row_count', (SELECT COUNT(*) FROM sensor_readings),
  'database_size_bytes', pg_database_size(current_database()),
  'database_size_pretty', pg_size_pretty(pg_database_size(current_database())),
  'distinct_timestamps', (SELECT COUNT(DISTINCT ts) FROM sensor_readings),
  'distinct_sensors', (SELECT COUNT(DISTINCT sensor_id) FROM sensor_readings),
  'first_reading', (SELECT MIN(ts) FROM sensor_readings),
  'last_reading', (SELECT MAX(ts) FROM sensor_readings),
  'metrics', COALESCE(
    (SELECT json_agg(metric_stats ORDER BY metric) FROM metric_stats),
    '[]'::json
  )
)::text;
"@

function Get-DatabaseSummary {
  param(
    [string]$Container,
    [string]$Database
  )

  $result = & docker exec $Container psql -X -qAt -U pulse -d $Database -c $summaryQuery
  if ($LASTEXITCODE -ne 0) {
    throw "No se pudo consultar la base '$Database' en el contenedor '$Container'. Comprueba que está iniciado."
  }

  $json = ($result -join "`n").Trim()
  if (-not $json) {
    throw "La base '$Database' no devolvió resultados."
  }

  return ($json | ConvertFrom-Json)
}

Write-Host "Consultando las dos bases de datos..."
$plain = Get-DatabaseSummary -Container $PlainContainer -Database "pulse_plain"
$timescale = Get-DatabaseSummary -Container $TimescaleContainer -Database "pulse_timescale"

Write-Host "`nResumen general"
@(
  [pscustomobject]@{
    Base                    = "PostgreSQL-Plain"
    Filas                   = [long]$plain.row_count
    TamanoBase              = $plain.database_size_pretty
    TiemposDistintos        = [long]$plain.distinct_timestamps
    Sensores                = [long]$plain.distinct_sensors
    PrimerRegistro          = $plain.first_reading
    UltimoRegistro          = $plain.last_reading
  }
  [pscustomobject]@{
    Base                    = "PostgreSQL-TimescaleDB"
    Filas                   = [long]$timescale.row_count
    TamanoBase              = $timescale.database_size_pretty
    TiemposDistintos        = [long]$timescale.distinct_timestamps
    Sensores                = [long]$timescale.distinct_sensors
    PrimerRegistro          = $timescale.first_reading
    UltimoRegistro          = $timescale.last_reading
  }
) | Format-Table -AutoSize

$rowDifference = [long]$plain.row_count - [long]$timescale.row_count
Write-Host "Diferencia de filas (PostgreSQL-Plain - PostgreSQL-TimescaleDB): $rowDifference"

$plainMetrics = @{}
foreach ($metric in $plain.metrics) {
  $plainMetrics[$metric.metric] = $metric
}

$timescaleMetrics = @{}
foreach ($metric in $timescale.metrics) {
  $timescaleMetrics[$metric.metric] = $metric
}

$allMetricNames = @($plainMetrics.Keys + $timescaleMetrics.Keys | Sort-Object -Unique)
$metricComparison = foreach ($name in $allMetricNames) {
  $plainMetric = $plainMetrics[$name]
  $timescaleMetric = $timescaleMetrics[$name]

  [pscustomobject]@{
    Metrica       = $name
    FilasPlain = if ($plainMetric) { [long]$plainMetric.rows } else { 0 }
    FilasTimescale = if ($timescaleMetric) { [long]$timescaleMetric.rows } else { 0 }
    MediaPlain = if ($plainMetric) { $plainMetric.avg_value } else { $null }
    MediaTimescale = if ($timescaleMetric) { $timescaleMetric.avg_value } else { $null }
    MinPlain   = if ($plainMetric) { $plainMetric.min_value } else { $null }
    MinTimescale  = if ($timescaleMetric) { $timescaleMetric.min_value } else { $null }
    MaxPlain   = if ($plainMetric) { $plainMetric.max_value } else { $null }
    MaxTimescale  = if ($timescaleMetric) { $timescaleMetric.max_value } else { $null }
  }
}

Write-Host "`nComparacion por metrica (recuento y valores)"
$metricComparison | Format-Table -AutoSize

Write-Host "`nNota: cada API genera sus propios registros; este script compara volumen y estadisticas, no igualdad exacta fila por fila."
