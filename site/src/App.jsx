import { useState } from 'react'
import { useEffect } from 'react'
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps'

// import heroImg from './assets/hero.png'
// import reactLogo from './assets/react.svg'
// import viteLogo from './assets/vite.svg'
import './App.css'


import Papa from 'papaparse'
import { GoogleMapsOverlay } from '@deck.gl/google-maps'
import { ScatterplotLayer } from '@deck.gl/layers'


// Layer for the beavers specifically
function BeaverLayer({ year }) {
  // make the map
  const map = useMap()
  const [rows, setRows] = useState([])
  const [overlay] = useState(() => new GoogleMapsOverlay({}))

  // load CSV once
  useEffect(() => {
    Papa.parse('beaver_data.csv', {
      download: true,
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (result) =>
        setRows(
          result.data.filter(
            (r) => Number.isFinite(r.decimalLatitude) && Number.isFinite(r.decimalLongitude)
          )
        ),
    })
  }, [])

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
    // const [overlay] = useState(() => new GoogleMapsOverlay({ interleaved: false }))
    overlay.setProps({
      layers: [
        new ScatterplotLayer({
          id: 'beavers',
          data: visible,
          getPosition: (d) => [d.decimalLongitude, d.decimalLatitude],
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



function App() {
  const [count, setCount] = useState(0)
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
          <BeaverLayer year={2015} />
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
