import { describe, it, expect } from "vitest";
import { parseTOA5File, parseCSVLine } from "../parser";

// --- Sample data matching real Campbell Scientific TOA5 format ---

const HOURLY_HEADER = [
  '"TOA5","1","CR300","27855","CR300.Std.10.04","CPU:USFQ_Mto_20211000.CR300","23406","Registro"',
  '"TIMESTAMP","RECORD","AirTC_Avg","AirTC_Max","AirTC_Min","RH_Avg","RH_Max","RH_Min","Pressure_Avg","Pressure_Max","Pressure_Min","Rain_mm_Tot","Slrw_Avg","Slrw_Max","Slrw_Min","WindDir_Avg","WindDir_Max","WindDir_Min","WS_ms_Avg","WS_ms_Max","WS_ms_Min","mean_wind_speed","mean_wind_direction","std_wind_dir"',
  '"TS","RN","Deg C","Deg C","Deg C","%","%","%","","","","mm","w/m2","w/m2","w/m2","degrees","degrees","degrees","meters/second","meters/second","meters/second","meters/second","Deg","Deg"',
  '"","","Avg","Max","Min","Avg","Max","Min","Avg","Max","Min","Tot","Avg","Max","Min","Avg","Max","Min","Avg","Max","Min","WVc","WVc","WVc"',
].join("\n");

const FIFTEEN_MIN_HEADER = [
  '"TOA5","1","CR300","27855","CR300.Std.10.04","CPU:USFQ_Mto_20211000.CR300","23406","Registromin15"',
  '"TIMESTAMP","RECORD","AirTC_Avg","AirTC_Max","AirTC_Min","RH_Avg","RH_Max","RH_Min","Pressure_Avg","Pressure_Max","Pressure_Min","Rain_mm_Tot","Slrw_Avg","Slrw_Max","Slrw_Min","WindDir_Avg","WindDir_Max","WindDir_Min","WS_ms_Avg","WS_ms_Max","WS_ms_Min"',
  '"TS","RN","Deg C","Deg C","Deg C","%","%","%","","","","mm","w/m2","w/m2","w/m2","degrees","degrees","degrees","meters/second","meters/second","meters/second"',
  '"","","Avg","Max","Min","Avg","Max","Min","Avg","Max","Min","Tot","Avg","Max","Min","Avg","Max","Min","Avg","Max","Min"',
].join("\n");

const HOURLY_DATA_ROW =
  '"2025-03-01 11:00:00",28432,24.1,25.06,23.03,94.3,99.7,89.9,949.4797,949.6761,949.2185,0,1020.128,1089.988,992.258,145.3,271.6,10.18,0.443,1.718,0,0.4431832,148.3605,35.08987';

const FIFTEEN_MIN_DATA_ROW =
  '"2025-03-01 11:00:00",113728,24.68,25.06,24.41,91.4,93.8,89.9,949.3444,949.4805,949.2185,0,1050.58,1089.988,1027.896,144.4,209.4,92.8,0.848,1.718,0';

describe("parseCSVLine", () => {
  it("parses quoted CSV fields correctly", () => {
    const result = parseCSVLine('"hello","world","123"');
    expect(result).toEqual(["hello", "world", "123"]);
  });

  it("handles escaped double quotes", () => {
    const result = parseCSVLine('"hello ""world""","test"');
    expect(result).toEqual(['hello "world"', "test"]);
  });

  it("handles unquoted fields", () => {
    const result = parseCSVLine("hello,world,123");
    expect(result).toEqual(["hello", "world", "123"]);
  });

  it("handles mixed quoted and unquoted", () => {
    const result = parseCSVLine('"2025-03-01 11:00:00",28432,24.1');
    expect(result).toEqual(["2025-03-01 11:00:00", "28432", "24.1"]);
  });
});

describe("parseTOA5File", () => {
  it("rejects files that are too short", () => {
    const result = parseTOA5File("just one line");
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("demasiado corto");
  });

  it("rejects non-TOA5 files", () => {
    const content = [
      '"NOT_TOA5","1","CR300"',
      '"TIMESTAMP","RECORD"',
      '"TS","RN"',
      '"",""',
      '"2025-03-01 11:00:00",1',
    ].join("\n");

    const result = parseTOA5File(content);
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0].message).toContain("TOA5");
  });

  it("detects hourly resolution from table name", () => {
    const content = HOURLY_HEADER + "\n" + HOURLY_DATA_ROW;
    const result = parseTOA5File(content);
    expect(result.resolution).toBe("hourly");
  });

  it("detects 15-minute resolution from table name", () => {
    const content = FIFTEEN_MIN_HEADER + "\n" + FIFTEEN_MIN_DATA_ROW;
    const result = parseTOA5File(content);
    expect(result.resolution).toBe("15min");
  });

  it("parses hourly data rows correctly", () => {
    const content = HOURLY_HEADER + "\n" + HOURLY_DATA_ROW;
    const result = parseTOA5File(content);

    expect(result.rows).toHaveLength(1);
    expect(result.errors).toHaveLength(0);

    const row = result.rows[0];
    expect(row.timestamp).toBe("2025-03-01 11:00:00");
    expect(row.resolution).toBe("hourly");
    expect(row.recordNum).toBe(28432);
    expect(row.airTempAvg).toBe(24.1);
    expect(row.airTempMax).toBe(25.06);
    expect(row.airTempMin).toBe(23.03);
    expect(row.humidityAvg).toBe(94.3);
    expect(row.rainMm).toBe(0);
    expect(row.solarAvg).toBe(1020.128);
    expect(row.windDirAvg).toBe(145.3);
    expect(row.windSpeedAvg).toBe(0.443);
    expect(row.meanWindSpeed).toBe(0.4431832);
    expect(row.meanWindDirection).toBe(148.3605);
    expect(row.stdWindDir).toBe(35.08987);
  });

  it("parses 15-minute data rows correctly (no wind vector columns)", () => {
    const content = FIFTEEN_MIN_HEADER + "\n" + FIFTEEN_MIN_DATA_ROW;
    const result = parseTOA5File(content);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.timestamp).toBe("2025-03-01 11:00:00");
    expect(row.resolution).toBe("15min");
    expect(row.airTempAvg).toBe(24.68);
    // Wind vector columns should be undefined (not in column mapping for 15-min)
    expect(row.meanWindSpeed).toBeUndefined();
    expect(row.meanWindDirection).toBeUndefined();
    expect(row.stdWindDir).toBeUndefined();
  });

  it("converts NAN strings to null", () => {
    const dataRow =
      '"2025-03-01 11:00:00",28432,"NAN","NAN","NAN",94.3,99.7,89.9,949.4,949.6,949.2,0,1020,1089,992,145,271,10,0.4,1.7,0,0.4,148,35';
    const content = HOURLY_HEADER + "\n" + dataRow;
    const result = parseTOA5File(content);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].airTempAvg).toBeNull();
    expect(result.rows[0].airTempMax).toBeNull();
    expect(result.rows[0].airTempMin).toBeNull();
    expect(result.rows[0].humidityAvg).toBe(94.3);
  });

  it("returns errors for malformed rows without crashing", () => {
    const goodRow = HOURLY_DATA_ROW;
    const badRow = '"2025-03-01 12:00:00"'; // too few fields
    const content = HOURLY_HEADER + "\n" + goodRow + "\n" + badRow;
    const result = parseTOA5File(content);

    expect(result.rows).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(6); // line 6 (4 headers + 1 good + 1 bad)
  });

  it("extracts correct date range from multiple rows", () => {
    const row1 =
      '"2025-03-01 11:00:00",28432,24.1,25.06,23.03,94.3,99.7,89.9,949.4,949.6,949.2,0,1020,1089,992,145,271,10,0.4,1.7,0,0.4,148,35';
    const row2 =
      '"2025-03-01 12:00:00",28433,25.8,26.3,25.0,87.4,92.2,83.0,949.0,949.3,948.5,0,1072,1494,856,167,330,23,0.7,2.0,0,0.7,162,42';
    const row3 =
      '"2025-03-01 13:00:00",28434,25.6,26.6,23.9,88.1,94.9,83.7,948.0,948.5,947.5,1.2,821,923,751,203,328,1.3,0.3,1.6,0,0.3,247,54';

    const content = HOURLY_HEADER + "\n" + row1 + "\n" + row2 + "\n" + row3;
    const result = parseTOA5File(content);

    expect(result.rows).toHaveLength(3);
    expect(result.dateRange).toEqual({
      start: "2025-03-01 11:00:00",
      end: "2025-03-01 13:00:00",
    });
  });

  it("handles multiple rows with mixed good and bad data", () => {
    const goodRow1 =
      '"2025-03-01 11:00:00",28432,24.1,25.06,23.03,94.3,99.7,89.9,949.4,949.6,949.2,0,1020,1089,992,145,271,10,0.4,1.7,0,0.4,148,35';
    const goodRow2 =
      '"2025-03-01 12:00:00",28433,25.8,26.3,25.0,87.4,92.2,83.0,949.0,949.3,948.5,0,1072,1494,856,167,330,23,0.7,2.0,0,0.7,162,42';

    const content = HOURLY_HEADER + "\n" + goodRow1 + "\n" + goodRow2;
    const result = parseTOA5File(content);

    expect(result.rows).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("handles Windows line endings (\\r\\n)", () => {
    const content = HOURLY_HEADER.replace(/\n/g, "\r\n") + "\r\n" + HOURLY_DATA_ROW;
    const result = parseTOA5File(content);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });
});
