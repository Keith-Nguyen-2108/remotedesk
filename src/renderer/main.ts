import './styles.css'
import { createAppView } from './ui/app-view'

const app = document.querySelector<HTMLDivElement>('#app')!
app.append(createAppView())
