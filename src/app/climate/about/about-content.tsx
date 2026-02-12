import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const VARIABLES = [
  { name: "AirTC_Avg / Max / Min", column: "air_temp_avg / max / min", unit: "°C", desc: "Temperatura del aire (promedio, máximo, mínimo por período)" },
  { name: "RH_Avg / Max / Min", column: "humidity_avg / max / min", unit: "%", desc: "Humedad relativa (promedio, máximo, mínimo)" },
  { name: "Pressure_Avg / Max / Min", column: "pressure_avg / max / min", unit: "hPa", desc: "Presión atmosférica a nivel de la estación" },
  { name: "Rain_mm_Tot", column: "rain_mm", unit: "mm", desc: "Precipitación total acumulada por período" },
  { name: "Slrw_Avg / Max / Min", column: "solar_avg / max / min", unit: "W/m²", desc: "Radiación solar global" },
  { name: "WindDir_Avg / Max / Min", column: "wind_dir_avg / max / min", unit: "grados", desc: "Dirección del viento (0°=Norte, 90°=Este)" },
  { name: "WS_ms_Avg / Max / Min", column: "wind_speed_avg / max / min", unit: "m/s", desc: "Velocidad del viento" },
  { name: "mean_wind_speed", column: "mean_wind_speed", unit: "m/s", desc: "Velocidad media del viento (vector, solo datos horarios)" },
  { name: "mean_wind_direction", column: "mean_wind_direction", unit: "grados", desc: "Dirección media del viento (vector, solo datos horarios)" },
  { name: "std_wind_dir", column: "std_wind_dir", unit: "grados", desc: "Desviación estándar de la dirección del viento (solo datos horarios)" },
];

export function AboutContent() {
  return (
    <div className="space-y-6 max-w-4xl">
      {/* Station Description */}
      <Card>
        <CardHeader>
          <CardTitle>Estación Meteorológica Central</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed">
          <p>
            La estación meteorológica central de FCAT está ubicada en la Estación Biológica
            de FCAT en la zona noroccidental del Ecuador (Zona UTM 17N: 648522E, 41272N).
            La estación recopila datos meteorológicos continuos desde el 2 de diciembre de 2021.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <h4 className="font-medium mb-1">Equipo</h4>
              <ul className="list-disc ml-4 space-y-0.5 text-muted-foreground">
                <li>Datalogger: Campbell Scientific CR300</li>
                <li>Programa: CPU:FCAT_central_final.CR300</li>
                <li>Formato de datos: TOA5 (tabla ASCII)</li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium mb-1">Resolución temporal</h4>
              <ul className="list-disc ml-4 space-y-0.5 text-muted-foreground">
                <li>Datos horarios: 24 registros/día</li>
                <li>Datos cada 15 minutos: 96 registros/día</li>
                <li>Descarga de datos: trimestral (en campo)</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Variables Table */}
      <Card>
        <CardHeader>
          <CardTitle>Variables Medidas</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variable (Datalogger)</TableHead>
                  <TableHead>Columna (Base de datos)</TableHead>
                  <TableHead>Unidad</TableHead>
                  <TableHead>Descripción</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {VARIABLES.map((v) => (
                  <TableRow key={v.name}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">{v.name}</TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">{v.column}</TableCell>
                    <TableCell className="whitespace-nowrap">{v.unit}</TableCell>
                    <TableCell className="text-muted-foreground">{v.desc}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Las marcas de tiempo se registran en hora local de Ecuador (UTC-5) tal como las reporta el datalogger.
            Los valores faltantes del sensor aparecen como &quot;NAN&quot; en los archivos originales
            y se almacenan como NULL en la base de datos.
          </p>
        </CardContent>
      </Card>

      {/* Citation Guidelines */}
      <Card>
        <CardHeader>
          <CardTitle>Cómo Citar los Datos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed">
          <p>
            Los datos meteorológicos son producto de una colaboración entre la Fundación para la
            Conservación de los Andes Tropicales (FCAT) y la Universidad San Francisco de Quito
            (USFQ). El uso de estos datos en publicaciones, informes o presentaciones requiere
            la siguiente citación:
          </p>

          <div className="space-y-3">
            <div>
              <h4 className="font-medium mb-1">Estación Central FCAT</h4>
              <blockquote className="border-l-2 pl-4 text-muted-foreground italic">
                Fundación para la Conservación de los Andes Tropicales (FCAT). Datos meteorológicos
                de la Estación Biológica FCAT, [período de datos]. Estación Campbell Scientific CR300,
                zona noroccidental del Ecuador.
              </blockquote>
            </div>

            <div>
              <h4 className="font-medium mb-1">Estaciones USFQ (si se utilizan datos adicionales)</h4>
              <blockquote className="border-l-2 pl-4 text-muted-foreground italic">
                Universidad San Francisco de Quito (USFQ) y Fundación para la Conservación de los
                Andes Tropicales (FCAT). Datos meteorológicos del proyecto colaborativo FCAT-USFQ,
                [período de datos]. Zona noroccidental del Ecuador.
              </blockquote>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Data Usage */}
      <Card>
        <CardHeader>
          <CardTitle>Uso de Datos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed">
          <ul className="list-disc ml-4 space-y-1.5 text-muted-foreground">
            <li>Los datos están disponibles para fines de investigación, educación y conservación.</li>
            <li>Se requiere citación adecuada en todas las publicaciones que utilicen estos datos.</li>
            <li>Para uso comercial o redistribución, se requiere autorización escrita de FCAT.</li>
            <li>Los datos se proporcionan &quot;tal cual&quot; — FCAT no garantiza la completitud de los registros durante períodos de mantenimiento del equipo.</li>
          </ul>

          <div className="mt-4 pt-4 border-t">
            <h4 className="font-medium mb-1">Contacto</h4>
            <p className="text-muted-foreground">
              Para solicitudes de acceso a datos, preguntas sobre la metodología o propuestas
              de colaboración, contacte a FCAT a través de{" "}
              <a href="https://fcat-ecuador.org" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                fcat-ecuador.org
              </a>.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
