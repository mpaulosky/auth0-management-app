// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RolesFeatureTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Integration
// =============================================

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

using UI.Components.Features.Roles;
using UI.ManagementApi;
using UI.Tests.Integration.Fixtures;

namespace UI.Tests.Integration.Components.Features.Roles;

public class RolesFeatureTests : IClassFixture<UiWebApplicationFactory>
{
	private readonly UiWebApplicationFactory _factory;

	public RolesFeatureTests(UiWebApplicationFactory factory)
	{
		ArgumentNullException.ThrowIfNull(factory);

		_factory = factory;
	}

	[Fact]
	public void Program_Started_RegistersTheRolesHandler()
	{
		// Arrange
		using IServiceScope scope = _factory.Services.CreateScope();

		// Act
		GetRolesOverviewHandler? handler = scope.ServiceProvider.GetService<GetRolesOverviewHandler>();

		// Assert
		handler.Should().NotBeNull("Program.cs calls AddRolesFeature()");
	}

	[Fact]
	public void Program_Started_RegistersTheManagementApiSeamOnce()
	{
		// Arrange

		// Act
		IEnumerable<IManagementApi> registrations = _factory.Services.GetServices<IManagementApi>();

		// Assert
		registrations.Should().ContainSingle("AddRolesFeature() calls AddManagementApi(), which registers IManagementApi once");
	}

	// The Users slice isn't in this branch, so the second registrant is a plain AddManagementApi() call, which is all
	// AddUsersFeature() adds to the seam.
	[Fact]
	public void AddRolesFeature_AnotherSliceAlsoRegistersTheManagementApi_RegistersIManagementApiOnce()
	{
		// Arrange
		using WebApplicationFactory<Program> factory = _factory.WithWebHostBuilder(builder =>
			builder.ConfigureTestServices(services =>
			{
				services.AddManagementApi();
				services.AddRolesFeature();
			}));

		// Act
		IEnumerable<IManagementApi> registrations = factory.Services.GetServices<IManagementApi>();

		// Assert
		registrations.Should().ContainSingle();
	}
}
