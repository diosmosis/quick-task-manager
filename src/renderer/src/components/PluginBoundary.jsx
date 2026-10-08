import { Component } from 'react'

// A plugin's component is ordinary app code once it is bundled, so a throw
// inside one would take the whole window down with it. This keeps the failure
// inside the plugin's own surface — a form's dialog, a view's tab — where it
// can be read and dismissed.
export default class PluginBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error: String((error && error.message) || error) }
  }

  componentDidCatch(error) {
    console.error(`Plugin component ${this.props.label} failed:`, error)
  }

  render() {
    if (this.state.error) {
      return <div className="plugin-form-error">{this.state.error}</div>
    }
    return this.props.children
  }
}
