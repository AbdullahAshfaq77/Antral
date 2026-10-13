import dragon from '../assets/dragon.png'

// Antral mark: the dragon. The source image sits on pure black, so `screen`
// blending (in CSS) drops the black and leaves only the glowing dragon over the
// app's dark surfaces.
function AntralLogo({ size = 40, animated = false, className = '' }) {
  return (
    <img
      src={dragon}
      width={size}
      height={size}
      alt="Antral"
      draggable="false"
      className={`dragon-logo ${animated ? 'dragon-logo-animated' : ''} ${className}`}
    />
  )
}

export default AntralLogo
