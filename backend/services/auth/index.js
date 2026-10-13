import "dotenv/config";
import "../../shared/dns.js"; // pin DNS so googleapis.com (Firebase certs) resolves
import express from "express";
import authRoutes from "./routes/auth.routes.js"

const port = process.env.PORT

const app = express()

app.use(express.json({ limit: "10kb" }))

app.get("/",(req,res)=>{
    res.json({message:"Hello from auth"})
})

app.use(authRoutes)

app.use((err, req, res, next) => {
    console.error(err)
    res.status(500).json({ message: "Something went wrong. Please try again." })
})

const start = async () => {
    // Users, sessions and sign-in codes now live in the shared local SQLite
    // database (opened on first use), so no MongoDB or Redis is needed.
    app.listen(port, () => {
        console.log(`server started at ${port}`)
    }).on("error", (error) => {
        console.error(`Auth service could not listen on port ${port}:`, error.message)
        process.exitCode = 1
    })
}

start().catch((error) => {
    console.error("Failed to start auth service:", error.message)
    process.exitCode = 1
})
