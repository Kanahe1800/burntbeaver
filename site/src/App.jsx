import { useState } from 'react'
import { useEffect } from 'react'
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps'

import './App.css'
import Papa from 'papaparse'
import { GoogleMapsOverlay } from '@deck.gl/google-maps'
import { ScatterplotLayer } from '@deck.gl/layers'



function pickColumn(fields, candidates) {
  return fields.find((f) => candidates.includes(f.trim().toLowerCase()))
}
function DatasetUpload({ onData }) {
  const [status, setStatus] = useState('No file loaded')

  const handleFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setStatus('Loading...')

    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      worker: true,
      complete: (result) => {
        const fields = result.meta.fields || []
        const latKey = pickColumn(fields, ['decimallatitude', 'latitude', 'lat'])
        const lngKey = pickColumn(fields, ['decimallongitude', 'longitude', 'lon', 'lng', 'long'])
        const yearKey = pickColumn(fields, ['year'])

        if (!latKey || !lngKey) {
          setStatus('Could not find latitude/longitude columns')
          return
        }

        const rows = result.data
          .map((r) => ({ lat: r[latKey], lng: r[lngKey], year: yearKey ? r[yearKey] : null }))
          .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))

        onData(rows)
        setStatus(`${rows.length.toLocaleString()} points loaded`)
      },
      error: (err) => setStatus(`Error: ${err.message}`),
    })
  } // <-- handleFile ends here

  return (
    <div
      style={{
        position: 'absolute',
        top: 10,
        left: 10,
        zIndex: 10,
        background: 'white',
        padding: '8px 10px',
        borderRadius: 8,
        boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        fontSize: 13,
        color: '#222',
      }}
    >
      <input type="file" accept=".csv,.tsv,.txt" onChange={handleFile} />
      <div style={{ marginTop: 4 }}>{status}</div>
    </div>
  )
}



// select only north america
function NorthAmericaLayer(){
  const map = useMap()

  useEffect(() => {
    if (!map) return

    // map.data.loadGeoJson('/NA.geojson', null, (features) => {
    //   const bounds = new google.maps.LatLngBounds()
    //   features.forEach((f) => f.getGeometry().forEachLatLng((latLng) => bounds.extend(latLng)))
    //   map.fitBounds(bounds)
    // })

    // map.data.setStyle({
    //   fillColor: '#9de2a1',
    //   fillOpacity: 0.35,
    //   strokeColor: '#1b5e20',
    //   strokeWeight: 1,
    // })

    map.data.addListener('mouseover', (e) => {map.data.overrideStyle(e.feature, { fillOpacity: 0.7 })})
    map.data.addListener('mouseout', () => {map.data.revertStyle()})
    map.data.addListener('click', (e) => {console.log(e.feature.getProperty('NAME'))})

    // clean up if the component unmounts
    return () => {
      map.data.forEach((feature) => map.data.remove(feature))
    }
  
  }, [map])
  
  return null
}

// Layer for the beavers specifically
function BeaverLayer({ rows, year }) {
  // make the map
  const map = useMap()
  const [overlay] = useState(() => new GoogleMapsOverlay({ interleaved: false }))

  // attach overlay to the map once it's fully initialized
  useEffect(() => {
    if (!map) return

    const listener = map.addListener('idle', () => {
      overlay.setMap(map)
      listener.remove()
    })

    return () => {
      listener.remove()
      overlay.setMap(null)
    }
  }, [map, overlay])

  // update layer when data or year changes
  useEffect(() => {
    const visible = year ? rows.filter((r) => r.year === year) : rows
    overlay.setProps({
      layers: [
        new ScatterplotLayer({
          id: 'beavers',
          data: visible,
          getPosition: (d) => [d.lng, d.lat],
          getRadius: 4000,
          radiusMinPixels: 2,
          getFillColor: [139, 69, 19, 160],
        }),
      ],
    })
  }, [rows, year, overlay])

  useEffect(() => {
    console.log('rows loaded:', rows.length, 'first row:', rows[0])
    console.log('rows for year:', rows.filter((r) => r.year === year).length)
  }, [rows, year])


  return null
}



function App() {
  // const [count, setCount] = useState(0)
  const [rows, setRows] = useState([])

  return (
    <>
    {/* header info */}
    <header style={{ padding: '1rem 2rem' }}>
      <h1>Burnt Beaver</h1>
    </header>

    <main style={{ maxWidth: 1000, margin: '0 auto', padding: '0 1rem' }}>
    <p>Some intro text above the map.</p>
    


    {/* this is to my api key */}
    <APIProvider apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}>

      {/*make a div for the map */}
      <div style={{ width: '60vw', height: '70vh' }}>

        <DatasetUpload onData={setRows} />

        {/* map */}
        <Map
          defaultCenter={{ lat: 50, lng: -100 }}
          defaultZoom={3}
          gestureHandling="greedy"
          disableDefaultUI={false}
          // restriction={{
          // latLngBounds: { north: 84, south: 5, west: -180, east: -50 },
          // strictBounds: true,
          // }}
        >
          <BeaverLayer rows={rows} year={null} />
          <NorthAmericaLayer />

        </Map>
      </div>
    </APIProvider>
  
      <p>Observation data like iNaturalist or GBIF reflects where people go looking, not just where beavers are.</p>

    </main>
  </>
  )
}


// this is what we share in the 
export default App
