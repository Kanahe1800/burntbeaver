## How the stats work

### Data

**1. Vegetation: NDVI**
MODIS/Terra Vegetation Indices Monthly L3 Global 1 km SIN Grid, V061 (MOD13A3).
- One value per 1 km pixel per month; NDVI ranges from -1 to 1 (higher = greener).
- Source: [NASA Earthdata](https://www.earthdata.nasa.gov/data/catalog/lpcloud-mod13a3-061)

**2. Fire: burned area**
MODIS/Terra+Aqua Burned Area Monthly L3 Global 500 m SIN Grid, V061 (MCD64A1).
- One value per 500 m pixel per month, recording the day of year that pixel burned
  (0 = did not burn).
- Source: [NASA Earthdata](https://www.earthdata.nasa.gov/data/catalog/lpcloud-mcd64a1-061)

### Building the grid

We study North America and divide it into **50 km × 50 km cells** using an equal-area
projection, so every cell covers the same area regardless of latitude. Each cell
summarizes all the satellite pixels whose centers fall inside it, one value per month:

| Variable | Summary for each cell and month |
|---|---|
| **NDVI** | The **average** of all valid pixels (cloud, water and missing data are excluded). |
| **Fire** | The **total number of pixels that burned at least once that month** (each is about 0.21 km²). |

Fire is a total rather than an average because burned area is rare and clustered:
an average would hide small fires, while a count shows how much burned in each cell.

If we’d built “50 km” cells in raw lat/lon degrees, cells in northern Canada would be much narrower than cells in Mexico, and “burned pixels per cell” would not be comparable across the continent. So in Step 1 we set CRS = "ESRI:102008", North America Albers Equal Area, and reprojected the land outline into it. In that system units are meters and every cell covers the same true area (50,000 m x 50,000 m), so counts and averages compare fairly everywhere.