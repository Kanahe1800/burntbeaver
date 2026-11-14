import { useState } from 'react'
import { useEffect } from 'react'
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps'

import heroImg from './assets/hero.png'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import './App.css'


// AIzaSyARpkWwBibVoWw93HqpAd7U6SbDyGODO-c
function NorthAmericaLayer(){
  const map = useMap()

  useEffect(() => {
    if (!map) return

    map.data.loadGeoJson('/merged.json')
    map.data.setStyle({
      fillColor: '#2e7d32',
      fillOpacity: 0.35,
      strokeColor: '#1b5e20',
      strokeWeight: 1,
    })

    map.data.addListener('mouseover', (e) => {map.data.overrideStyle(e.feature, { fillOpacity: 0.7 })})
    map.data.addListener('mouseout', () => {map.data.revertStyle()})
    map.data.addListener('click', (e) => {console.log(e.feature.getProperty('NAME'))})

    // clean up if the component unmounts
    return () => {
      map.data.forEach((feature) => map.data.remove(feature))
    }
  
  }, [map])
  
}


function App() {
  const [count, setCount] = useState(0)
  return (
    // this is to my api key
    <APIProvider apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}>

      {/*make a div for the map */}
      <div style={{ width: '100vw', height: '100vh' }}>
        <Map
          defaultCenter={{ lat: 50, lng: -100 }}
          defaultZoom={3}
          gestureHandling="greedy"
          disableDefaultUI={false}
        >
          <NorthAmericaLayer />
        </Map>
      </div>
    </APIProvider>
  )
}


// this is what we share in the 
export default App
