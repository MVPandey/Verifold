/** An image that the app imports. The build gives the module the image's URL. */
declare module '*.webp' {
  const url: string;
  export default url;
}
