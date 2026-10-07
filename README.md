# Municipal Infrastructure GIS Platform

A web-based GIS platform built for municipal infrastructure management in Temirtau, Kazakhstan.

The platform combines interactive mapping, infrastructure data management, spatial analysis, cloud synchronization, and field-oriented tools in a single browser-based application.

**[Live Demo](https://temirtauupcois.vercel.app/)** · **[Source Code](https://github.com/Spiller250/temirtau-gis-platform)**

---

## Project Overview

Municipal infrastructure is distributed across large geographic areas, making it difficult to manage using static spreadsheets and separate data sources.

This project provides a centralized map-based interface for visualizing, searching, organizing, and updating infrastructure data.

The system was developed around a real municipal use case in Temirtau, Kazakhstan.

---

## Key Features

### Interactive GIS

* Interactive map built with Leaflet
* Infrastructure points and polygon layers
* Administrative areas and geographic zones
* Search and filtering
* Custom map markers and data visualization

### Infrastructure Management

* Structured registry of mapped objects
* Add, edit, and remove infrastructure records
* Object information displayed directly on the map
* Photo attachments for mapped objects

### Spatial Analysis

* Point-in-polygon analysis
* Automatic geographic classification of objects
* Polygon-based area selection and filtering

### Cloud Data

* Firebase Firestore database
* Firebase Storage for uploaded images
* Data synchronization between clients
* Local persistence fallback for unreliable connections

### Field-Oriented Workflow

* Responsive interface for mobile devices
* Map-first navigation
* Quick object lookup and editing
* Address and route utilities

### Localization

* Russian language
* Kazakh language
* Responsive desktop and mobile layouts

---

## Technical Stack

**Frontend**

* HTML5
* CSS3
* Vanilla JavaScript

**Mapping**

* Leaflet.js
* GeoJSON
* Point-in-polygon spatial processing

**Backend / Cloud**

* Firebase Firestore
* Firebase Storage

**Persistence**

* Browser local storage

**Deployment**

* Vercel

---

## My Role

**Developer**

I designed and implemented the web application, including the interactive GIS interface, map layers, infrastructure management workflows, spatial processing, Firebase integration, responsive UI, and deployment.

---

## Technical Highlights

### Spatial Data Processing

The application uses geographic coordinates and polygon boundaries to determine which administrative or geographic area a mapped object belongs to.

### Cloud Synchronization

Infrastructure data can be synchronized through Firestore, while local persistence provides a fallback when the network connection is unavailable.

### Map-Based Data Management

Instead of managing infrastructure exclusively through tables, users can locate and interact with objects directly on the map.

### Responsive Interface

The interface was designed for both desktop and mobile environments, allowing the system to be used outside of a traditional office workstation.

---

## Project Context

This project was created for a real municipal infrastructure use case in Temirtau, Kazakhstan.

The public repository is intended to demonstrate the technical implementation and architecture of the project. Operational data and sensitive configuration may be omitted or sanitized.

---

## Screenshots

### Main GIS Interface

*Add screenshot here*

### Infrastructure Object

*Add screenshot here*

### Data Management / Editing

*Add screenshot here*

### Mobile Interface

*Add screenshot here*

---

## What This Project Demonstrates

This project demonstrates practical experience with:

* Web GIS development
* Interactive mapping
* Geographic data processing
* Cloud databases
* CRUD application architecture
* Responsive web interfaces
* Firebase integration
* Data visualization
* Deployment of production-oriented web applications

---

## Author

**Bogdan Shutov**

Web & GIS Developer

Interested in software engineering, geospatial systems, embedded systems, and aerospace engineering.
