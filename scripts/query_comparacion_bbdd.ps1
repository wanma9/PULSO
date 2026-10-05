$job1 = Start-Job {
    docker exec pulse-postgres-timescale psql -U pulse -d pulse_timescale -c "SELECT current_database() AS base_de_datos, ts, sensor_id, district, metric, value FROM sensor_readings ORDER BY ts DESC LIMIT 20;"
}

$job2 = Start-Job {
    docker exec pulse-postgres-plain psql -U pulse -d pulse_plain -c "SELECT current_database() AS base_de_datos, ts, sensor_id, district, metric, value FROM sensor_readings ORDER BY ts DESC LIMIT 20;"
}

Wait-Job $job1, $job2
Receive-Job $job1
Receive-Job $job2
Remove-Job $job1, $job2