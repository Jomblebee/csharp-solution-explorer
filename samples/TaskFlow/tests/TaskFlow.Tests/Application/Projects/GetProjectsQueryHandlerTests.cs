using Microsoft.EntityFrameworkCore;
using TaskFlow.Application.Projects.Queries.GetProjects;
using TaskFlow.Domain.Entities;
using TaskFlow.Infrastructure.Persistence;
using Xunit;

namespace TaskFlow.Tests.Application.Projects;

public class GetProjectsQueryHandlerTests
{
    private static TaskFlowDbContext CreateContext(string dbName)
    {
        var options = new DbContextOptionsBuilder<TaskFlowDbContext>()
            .UseInMemoryDatabase(dbName)
            .Options;
        return new TaskFlowDbContext(options);
    }

    [Fact]
    public async Task Handle_WithProjects_ReturnsDtoList()
    {
        await using var context = CreateContext(nameof(Handle_WithProjects_ReturnsDtoList));
        context.Projects.AddRange(
            new Project { Name = "Alpha" },
            new Project { Name = "Beta" });
        await context.SaveChangesAsync();

        var handler = new GetProjectsQueryHandler(context);
        var result = await handler.Handle(new GetProjectsQuery(), default);

        Assert.Equal(2, result.Count);
        Assert.Contains(result, p => p.Name == "Alpha");
        Assert.Contains(result, p => p.Name == "Beta");
    }

    [Fact]
    public async Task Handle_EmptyDatabase_ReturnsEmptyList()
    {
        await using var context = CreateContext(nameof(Handle_EmptyDatabase_ReturnsEmptyList));
        var handler = new GetProjectsQueryHandler(context);
        var result = await handler.Handle(new GetProjectsQuery(), default);
        Assert.Empty(result);
    }
}
